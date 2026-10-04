import { launch } from '../launch.mjs';
import http from 'node:http';
const [exe, lang] = process.argv.slice(2);
const html=`<!doctype html><button id=b>go</button><script>
window.out=[];const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
document.getElementById('b').onclick=async()=>{const o={langs:['${lang}'],processLocally:true};
 out.push('before:'+await SR.available(o));
 const t=setTimeout(()=>out.push('install still pending after 90s'),90000);
 try{const r=await SR.install(o); out.push('install:'+r);}catch(e){out.push('install err:'+e.name+' '+e.message)}
 out.push('after:'+await SR.available(o)); out.push('DONE');};
</script>`;
const srv = http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end(html)}).listen(0);
const L = await launch(exe, { extraArgs: ['--use-fake-ui-for-media-stream'] });
const p = await L.browser.newPage();
await p.goto(`http://localhost:${srv.address().port}/`);
await p.click('#b');
for(let i=0;i<100;i++){ await new Promise(r=>setTimeout(r,1000)); const o=await p.evaluate(()=>window.out); if(o.includes('DONE')||i==99){console.log(o.join('\n'));break;} }
await L.close(); srv.close(); process.exit(0);
