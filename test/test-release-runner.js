const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../src/main/runner');
const { detectNode } = require('../src/main/detect-node');

test('Next/Vue/Angular must not receive Vite strictPort', () => {
  for (const type of ['next', 'nuxt', 'vue-cli', 'angular', 'generic-dev']) {
    assert.equal(runner.buildFrameworkArgs('npm run dev', 8123, type).includes('--strictPort'), false, type);
  }
  assert.ok(runner.buildFrameworkArgs('npm run dev', 8123, 'vite').includes('--strictPort'));
  assert.deepEqual(runner.buildFrameworkArgs('npm start', 8123, 'react-scripts'), ['start']);
});
test('Windows Node discovers where.exe and validates executable', () => {
  const called=[];
  const found=detectNode({platform:'win32', env:{PATH:'C:\\Node',USERPROFILE:'C:\\Users\\Test'}, existsSync:()=>true,
    execFileSync:(cmd,args)=>{called.push(cmd); if(cmd==='where.exe') return 'C:\\Node\\node.exe\r\n'; if(cmd==='C:\\Node\\node.exe') return 'v24.1.0'; throw Error('missing');}});
  assert.equal(found && found.path, 'C:\\Node\\node.exe');
  assert.ok(called.includes('where.exe'));
});
test('Windows PATH preserves semicolon delimiters and case', () => {
  const env=runner.buildEnvironment({Path:'C:\\Windows',ELECTRON_RUN_AS_NODE:'1'}, 'C:\\Node', 'win32');
  assert.equal(env.Path,'C:\\Node;C:\\Windows');
  assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);
});
test('loopback servers reject arbitrary Host and cross-site Origin', () => {
  const { isTrustedLocalRequest }=require('../src/main/local-http-security');
  assert.equal(isTrustedLocalRequest({headers:{host:'127.0.0.1:47800'}}),true);
  assert.equal(isTrustedLocalRequest({headers:{host:'attacker.test:47800'}}),false);
  assert.equal(isTrustedLocalRequest({headers:{host:'127.0.0.1:47800',origin:'https://attacker.test'}}),false);
  assert.equal(isTrustedLocalRequest({headers:{host:'127.0.0.1:47800',origin:'http://127.0.0.1:47800'}}),true);
  assert.equal(isTrustedLocalRequest({headers:{host:'127.0.0.1:47800',origin:'http://127.0.0.1:8091'}}),false);
});
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
test('framework process exit fails promptly rather than hanging 150 seconds', () => {
  const result=spawnSync(process.execPath,['-e',`
    const r=require('./src/main/runner');
    r.startProject({id:'exit',path:process.cwd(),framework:true,type:'generic-dev',startCommand:'node -e "process.exit(7)"'},[49100,49110],()=>{},{nodeBinDir:require('path').dirname(process.execPath)}).then(x=>{console.log(JSON.stringify(x));r.stopAll()});
  `],{cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined,String(result.error));
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).ok,false);
});
test('concurrent static starts share one instance; stop while starting leaves none', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'runner-race-'));fs.writeFileSync(path.join(tmp,'index.html'),'ok');
  const project={id:'race',path:tmp,name:'race',framework:false};
  try {
    const [a,b]=await Promise.all([runner.startProject(project,[49200,49210]),runner.startProject(project,[49200,49210])]);
    assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a.instance,b.instance);
    runner.stopProject(project.id);
    const pending=runner.startProject({...project,id:'cancel'},[49211,49220]);
    runner.stopProject('cancel');
    const c=await pending;assert.equal(c.ok,false);assert.equal(runner.getStatus().length,0);
  } finally {runner.stopAll();fs.rmSync(tmp,{recursive:true,force:true});}
});
test('framework with no Local banner starts by health and stop reclaims grandchild port', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'runner-tree-'));
  fs.writeFileSync(path.join(tmp,'server.js'),`require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')`);
  fs.writeFileSync(path.join(tmp,'parent.js'),`require('child_process').spawn(process.execPath,['server.js'],{stdio:'inherit'});setInterval(()=>{},1000)`);
  try {
    const a=await runner.startProject({id:'tree',name:'tree',path:tmp,framework:true,type:'generic-dev',startCommand:'node parent.js'},[49300,49310],()=>{},{nodeBinDir:path.dirname(process.execPath)});
    assert.equal(a.ok,true,a.error);assert.equal(await runner.isPortFree(a.instance.port),false);
    runner.stopProject('tree');
    await new Promise(r=>setTimeout(r,500));
    assert.equal(await runner.isPortFree(a.instance.port),true);
  } finally {runner.stopAll();fs.rmSync(tmp,{recursive:true,force:true});}
});
test('Windows tree stop uses taskkill /T /F, not POSIX group signals', () => {
  const vm=require('vm'); const calls=[];
  const sandbox={module:{exports:{}},require:(name)=>name==='child_process'?{spawn(){},execFileSync:(...args)=>calls.push(args)}:require(name.startsWith('.')?path.join(__dirname,'../src/main',name):name),process:{platform:'win32'},setTimeout,clearTimeout,AbortController,fetch,console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main/runner.js'),'utf8')+'\nmodule.exports.disposeInstance=disposeInstance;',sandbox);
  sandbox.module.exports.disposeInstance({proc:{pid:12345}});
  assert.equal(calls[0][0],'taskkill.exe');assert.deepEqual(Array.from(calls[0][1]),['/PID','12345','/T','/F']);
});
test('failed or cancelled startup kills descendants before they open delayed ports', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'runner-failure-'));
  fs.writeFileSync(path.join(tmp,'late.js'),`setTimeout(()=>require('http').createServer((q,s)=>s.end('late')).listen(Number(process.env.PORT),'127.0.0.1'),1000)`);
  fs.writeFileSync(path.join(tmp,'fail.js'),`require('child_process').spawn(process.execPath,['late.js'],{stdio:'inherit'});process.exit(7)`);
  try {
    const failure=await runner.startProject({id:'failure',name:'failure',path:tmp,framework:true,type:'generic-dev',startCommand:'node fail.js'},[49400,49400],()=>{},{nodeBinDir:path.dirname(process.execPath)});
    assert.equal(failure.ok,false);
    const pending=runner.startProject({id:'pending',name:'pending',path:tmp,framework:true,type:'generic-dev',startCommand:'node late.js'},[49401,49401],()=>{},{nodeBinDir:path.dirname(process.execPath)});
    await new Promise(r=>setTimeout(r,100));runner.stopProject('pending');
    assert.equal((await pending).ok,false);
    await new Promise(r=>setTimeout(r,1100));
    assert.equal(await runner.isPortFree(49400),true);assert.equal(await runner.isPortFree(49401),true);
    assert.equal(runner.getStatus().length,0);
  } finally {runner.stopAll();fs.rmSync(tmp,{recursive:true,force:true});}
});
test('control and dev navigation servers reject cross-site mutations over HTTP', async () => {
  const vm=require('vm'),http=require('http');let stopped=0;
  const sandbox={module:{exports:{}},require:(name)=>name==='electron'?{shell:{openExternal(){}}}:require(name.startsWith('.')?path.join(__dirname,'../src/main',name):name),console,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main/control-server.js'),'utf8').replace('const CTRL_PORT = 47800','const CTRL_PORT = 0'),sandbox);
  const ctrl=await sandbox.module.exports.createControlServer({getStore:()=>({projects:[],settings:{}}),stopProject:()=>stopped++,getStatus:()=>[],onLog:()=>{}});
  const port=ctrl.server.address().port;
  const request=(p,headers={})=>new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:p,path:'/stop',method:'POST',headers},s=>{s.resume();s.on('end',()=>resolve(s.statusCode))});q.on('error',reject);q.end('{"id":"test"}')});
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nav-security-'));
  let nav;
  try {
    assert.equal(await request(port,{origin:'https://evil.test','content-type':'text/plain'}),403);
    assert.equal(await request(port,{host:'evil.test'}),403);
    assert.equal(stopped,0);assert.equal(await request(port),200);assert.equal(stopped,1);
    nav=await require('../src/main/dev-nav').createDevNavServer({projectRoot:tmp,projectName:'test',devBaseUrl:'http://127.0.0.1:1234',onLog:()=>{}});
    assert.equal(await request(nav.port,{origin:'https://evil.test'}),403);
    assert.equal(await request(nav.port,{host:'evil.test'}),403);
  } finally {ctrl.server.close();nav?.server.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
test('different framework projects choose distinct ports during concurrent startup', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'runner-distinct-'));
  fs.writeFileSync(path.join(tmp,'server.js'),`require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')`);
  const p={name:'test',path:tmp,framework:true,type:'generic-dev',startCommand:'node server.js'};
  try {
    const [a,b]=await Promise.all(['first','second'].map(id=>runner.startProject({...p,id},[49500,49510],()=>{},{nodeBinDir:path.dirname(process.execPath)})));
    assert.equal(a.ok,true,a.error);assert.equal(b.ok,true,b.error);assert.notEqual(a.instance.port,b.instance.port);
  } finally {runner.stopAll();fs.rmSync(tmp,{recursive:true,force:true});}
});
