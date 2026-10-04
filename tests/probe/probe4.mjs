import { launch } from '../launch.mjs';
import http from 'node:http'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
const [exe, lang, wav] = process.argv.slice(2);
const html=`<!doctype html><button id=b>go</button><script>
window.out=[];const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
document.getElementById('b').onclick=async()=>{const o={langs:['${lang}'],processLocally:true};
 out.push('before:'+await SR.available(o));
 try{const r=await SR.install(o); out.push('install:'+r);}catch(e){out.push('install err:'+e.name+' '+e.message)}
 out.push('after:'+await SR.available(o)); out.push('INSTALLED');
};
window.rec=()=>{const r=new SR(); r.lang='${lang}'; r.processLocally=true; r.continuous=true; r.interimResults=true;
 r.onstart=()=>out.push('start'); r.onaudiostart=()=>out.push('audiostart');
 r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++)out.push((e.results[i].isFinal?'FINAL ':'interim ')+e.results[i][0].transcript)};
 r.onerror=e=>out.push('error '+e.error+' '+(e.message||'')); r.onend=()=>out.push('END'); r.start(); setTimeout(()=>{try{r.stop()}catch(e){}},14000);};
</script>`;
const srv = http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end(html)}).listen(0);
const L = await launch(exe, { extraArgs: ['--use-fake-ui-for-media-stream'] });
const p = await L.browser.newPage();
await p.goto(`http://localhost:${srv.address().port}/`);
await p.click('#b');
const wait=async(tag,n)=>{for(let i=0;i<n;i++){await new Promise(r=>setTimeout(r,1000)); const o=await p.evaluate(()=>window.out); if(o.includes(tag))return;}};
await wait('INSTALLED',90);
const {execSync}=await import('node:child_process');
for(let i=0;i<36;i++){ await new Promise(r=>setTimeout(r,5000)); let ls=''; try{ls=execSync(`find ${L.profile} -maxdepth 3 -iname '*soda*'`).toString();}catch{}; const so=execSync(`find ${L.profile} -name 'libsoda*' 2>/dev/null || true`).toString(); console.log('t',i*5,'soda dirs:',ls.trim().split('\n').length, 'lib:',so.trim()); if(so.trim() && i>=8) { console.log(execSync(`find ${L.profile}/SODA* -maxdepth 3 | head -40`).toString()); break;} }
await p.evaluate(()=>window.rec());
setTimeout(()=>spawn('paplay',['-d','vmic',wav]), 2000);
await wait('END',30);
console.log('--- second try'); await p.evaluate(()=>{window.out.push('SECOND'); window.rec();}); setTimeout(()=>spawn('paplay',['-d','vmic',wav]), 2500); await new Promise(r=>setTimeout(r,20000));
console.log((await p.evaluate(()=>window.out)).join('\n'));
console.log('STDERR:', L.stderr().split('\n').filter(l=>/soda|speech|Speech|SODA/i.test(l)).slice(-15).join('\n'));
await L.close(); srv.close(); process.exit(0);
