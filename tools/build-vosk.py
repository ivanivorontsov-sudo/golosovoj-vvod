#!/usr/bin/env python3
"""Builds a CSP-safe (MV3) copy of vosk-browser 0.0.8.
- extracts the inline base64 worker into lib/vosk-worker.js (no blob: workers)
- replaces embind's runtime code generation (new Function) with closures
- uses a stable model cache key (#key=...) so the model is extracted into IDBFS only once."""
import re, base64, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
out = pathlib.Path(sys.argv[2])
m = re.search(r"createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'", src)
worker = base64.b64decode(m.group(1)).decode('utf-8')
worker = worker[worker.index('\n', 10) + 1:]   # drop the rollup loader comment line, like createURL() does

def sub(old, new, s, count=1):
    assert s.count(old) >= 1, 'pattern not found: ' + old[:80]
    return s.replace(old, new, count)

# 1. createNamedFunction without eval
worker = re.sub(r'function createNamedFunction\(name,body\)\{name=makeLegalFunctionName\(name\);return new Function\([^\n]*?\)\(body\)\}',
                'function createNamedFunction(name,body){return function(){return body.apply(this,arguments)}}', worker, count=1)
assert 'new Function(' not in worker, 'createNamedFunction patch failed'

# 2. craftInvokerFunction without eval
i = worker.index('function craftInvokerFunction(')
a = worker.index('var argsList="";', i)
b = worker.index('return invokerFunction}', a) + len('return invokerFunction}')
worker = worker[:a] + ('var expectedArgs=argCount-2;return function(){if(arguments.length!==expectedArgs){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expectedArgs+" args!");}'
  'var destructors=needsDestructorStack?[]:null;var wired=[cppTargetFunc];var thisWired;'
  'if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired);}'
  'var argsWired=new Array(expectedArgs);for(var i=0;i<expectedArgs;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);wired.push(argsWired[i]);}'
  'var rv=cppInvokerFunc.apply(null,wired);'
  'if(needsDestructorStack){runDestructors(destructors);}else{for(var j=isClassMethodFunc?1:2;j<argTypes.length;++j){var p=j===1?thisWired:argsWired[j-2];if(argTypes[j].destructorFunction!==null){argTypes[j].destructorFunction(p);}}}'
  'if(returns){return argTypes[0].fromWireType(rv);}}}') + worker[b:]

# 3. emval method caller without eval
i = worker.index('function __emval_get_method_caller(')
a = worker.index('var functionName=', i)
b = worker.index('var invokerFunction=new_(Function,params).apply(null,args);', a) + len('var invokerFunction=new_(Function,params).apply(null,args);')
worker = worker[:a] + ('var invokerFunction=function(handle,name,destructors,argsPtr){var vals=new Array(argCount-1);var offset=0;'
  'for(var i=0;i<argCount-1;++i){vals[i]=types[i+1].readValueFromPointer(argsPtr+offset);offset+=types[i+1]["argPackAdvance"];}'
  'var rv=handle[name].apply(handle,vals);for(var i=0;i<argCount-1;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(vals[i]);}}'
  'if(!retType.isVoid){return retType.toWireType(destructors,rv);}};') + worker[b:]
assert 'new_(Function' not in worker

# 4. stable cache key: modelUrl may carry "#key=<name>"
worker = sub('const modelPath = storagePath + "/" + modelUrl.replace(/[\\W]/g, "_");',
             'const modelPath = storagePath + "/" + ((modelUrl.split("#key=")[1]) || modelUrl).replace(/[\\W]/g, "_");', worker)

(out / 'vosk-worker.js').write_text('/* vosk-browser 0.0.8 worker (Apache-2.0, github.com/ccoreilly/vosk-browser), patched for MV3 CSP */\n' + worker)

# main library: use the worker file instead of a blob: URL
lib = src[:m.start()] + "createBase64WorkerFactory('')" + src[m.end()-1+1:] if False else src
lib = re.sub(r"var WorkerFactory = createBase64WorkerFactory\('[A-Za-z0-9+/=]+', null, false\);",
             "var WorkerFactory = function (options) { return new Worker((self.chrome && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('lib/vosk-worker.js') : 'vosk-worker.js', options); };", lib, count=1)
assert 'createBase64WorkerFactory(\'Ly' not in lib, 'worker factory patch failed'
(out / 'vosk.js').write_text('/* vosk-browser 0.0.8 (Apache-2.0, github.com/ccoreilly/vosk-browser), patched for MV3 CSP */\n' + lib)
print('ok', len(worker), len(lib))
