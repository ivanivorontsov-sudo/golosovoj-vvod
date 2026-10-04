import { launch } from '../launch.mjs';
import http from 'node:http'; import { spawn } from 'node:child_process';
const [exe, lang, wav, prof, phase] = process.argv.slice(2);
const html=`<!doctype html><button id=b>go</button><script>
window.out=[];const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
document.getElementById('b').onclick=async()=>{const o={langs:['${lang}'],processLocally:true};
 out.push('before:'+await SR.available(o));
 if(${phase==='install'}){ try{const r=await SR.install(o); out.push('install:'+r); out.push('install en:'+await SR.install({langs:['en-US'],processLocally:true}));}catch(e){out.push('install err:'+e.name+' '+e.message)} }
 out.push('after:'+await SR.available(o)); out.push('READY');
};
window.rec=()=>{const r=new SR(); r.lang='${lang}'; r.processLocally=true; r.continuous=true; r.interimResults=true;
 r.onstart=()=>out.push('start'); r.onaudiostart=()=>out.push('audiostart');
 r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++)out.push((e.results[i].isFinal?'FINAL ':'interim ')+e.results[i][0].transcript)};
 r.onerror=e=>out.push('error '+e.error+' '+(e.message||'')); r.onend=()=>out.push('END'); r.start(); setTimeout(()=>{try{r.stop()}catch(e){}},14000);};
</script>`;
const srv = http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end(html)}).listen(18234);
const L = await launch(exe, { extraArgs: ['--use-fake-ui-for-media-stream'], profileDir: prof, keepProfile: true });
const p = await L.browser.newPage();
await p.goto(`http://localhost:18234/`);
await p.click('#b');
const wait=async(tag,n)=>{for(let i=0;i<n;i++){await new Promise(r=>setTimeout(r,1000)); const o=await p.evaluate(()=>window.out); if(o.includes(tag))return;}};
await wait('READY',90);
if (phase==='install') { await new Promise(r=>setTimeout(r,45000)); }
else { await p.evaluate(()=>window.rec()); setTimeout(()=>spawn('paplay',['-d','vmic',wav]), 2000); await wait('END',30); }
console.log((await p.evaluate(()=>window.out)).join('\n'));
console.log('STDERR:', L.stderr().split('\n').filter(l=>/soda|speech|key|licen|error/i.test(l)).slice(-40).join('\n'));
await L.close(); srv.close(); process.exit(0);
