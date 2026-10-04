import { launch } from '../launch.mjs';
const exe = process.argv[2];
const L = await launch(exe, { extensionDir: '/workspace/golosovoj-vvod/extension' });
await new Promise(r=>setTimeout(r,4000));
console.log(L.browser.targets().map(t=>t.type()+' '+t.url()).join('\n'));
console.log(L.stderr().split('\n').filter(l=>/extension|manifest|load/i.test(l)).slice(-10).join('\n'));
await L.close(); process.exit(0);
