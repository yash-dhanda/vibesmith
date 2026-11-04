import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCodexServer } from './codexServer'
import type { TeamEvent } from './events'

// A stand-in `codex` that speaks the app-server protocol (shapes captured from codex-cli 0.153).
const fake = (body: string) => {
  const d = mkdtempSync(join(tmpdir(), 'forge-fake-codex-'))
  const f = join(d, 'codex')
  writeFileSync(f, `#!${process.execPath}\nconst rl=require('readline').createInterface({input:process.stdin});const out=(m)=>console.log(JSON.stringify(m));let steered=null;let approval=null;\n${body}`)
  chmodSync(f, 0o755)
  return f
}
const SERVER = `
rl.on('line',(l)=>{const m=JSON.parse(l);
 if(m.method==='initialize') out({id:m.id,result:{userAgent:'fake'}});
 else if(m.method==='thread/start'||m.method==='thread/resume') out({id:m.id,result:{thread:{id:'T1'}}});
 else if(m.method==='turn/start'){ out({id:m.id,result:{turn:{id:'U1'}}}); out({method:'turn/started',params:{turn:{id:'U1'}}});
   out({method:'item/agentMessage/delta',params:{itemId:'m0',delta:'Plan: '}}); out({method:'item/commandExecution/outputDelta',params:{itemId:'c1',delta:'PASS'}});
   out({method:'item/started',params:{item:{type:'commandExecution',id:'c1',command:"/bin/zsh -lc 'npm test'"}}});
   out({id:77,method:'item/commandExecution/requestApproval',params:{command:'npm install',reason:'needs network'}}); }
 else if(m.id===77){ approval=m.result.decision;
   out({method:'item/completed',params:{item:{type:'commandExecution',id:'c1',exitCode:0,aggregatedOutput:'ok'}}});
   out({method:'item/started',params:{item:{type:'fileChange',id:'f1',changes:[{path:process.cwd()+'/a.js',kind:{type:'add'},diff:'+hello\\n'}]}}});
   out({method:'item/completed',params:{item:{type:'fileChange',id:'f1',status:'completed',changes:[]}}});
   out({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:1100,cachedInputTokens:500,outputTokens:30,reasoningOutputTokens:5},last:{inputTokens:100,cachedInputTokens:50,outputTokens:30,reasoningOutputTokens:5}}}});
   out({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:42,resetsAt:1000},secondary:{usedPercent:7,resetsAt:2000}}}});
   out({method:'item/completed',params:{item:{type:'agentMessage',id:'m1',text:'final: approval='+approval+' steered='+steered,phase:'final_answer'}}});
   out({method:'turn/completed',params:{turn:{id:'U1',status:'completed'}}}); }
 else if(m.method==='turn/steer'){ steered=m.params.input[0].text+'|'+m.params.expectedTurnId; out({id:m.id,result:{turnId:'U1'}}); }
});`

// the stand-in `codex` is a shebang script: POSIX only
describe.skipIf(process.platform === 'win32')('codex app-server adapter', () => {
  it('maps items, approvals, usage deltas and plan limits, and answers the approval it was given', async () => {
    const evs: TeamEvent[] = []
    const asked: string[] = []
    const r = await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm', onEvent: (e) => evs.push(e), onApproval: async (a) => (asked.push(a.title), true) }, fake(SERVER))
    expect(r.ok).toBe(true)
    expect(r.text).toBe('final: approval=accept steered=null')
    expect(r.sessionId).toBe('T1')
    expect(asked).toEqual(['Codex wants to run: npm install'])
    expect(evs.map((e) => e.type)).toEqual(['session', 'delta', 'delta', 'tool', 'tool_result', 'code', 'tool', 'tool_result', 'limits', 'text', 'usage', 'done'])
    expect(evs.find((e) => e.type === 'code')).toMatchObject({ path: 'a.js', kind: 'diff', text: '+hello\n', done: false })
    expect(evs.filter((e) => e.type === 'delta').map((e: any) => [e.channel, e.text])).toEqual([['text', 'Plan: '], ['output', 'PASS']])
    expect(evs.find((e) => e.type === 'tool' && e.kind === 'command')).toMatchObject({ summary: 'npm test' })
    expect(evs.find((e) => e.type === 'limits')).toMatchObject({ primaryPct: 42, secondaryPct: 7 })
    expect(r.usage).toMatchObject({ input: 100, output: 35, cached: 50 }) // this run only: the thread's total minus what it had before the run
  })

  it('declines when nobody answers for the user, and steers a running turn', async () => {
    let handle: any
    const slow = SERVER.replace("out({id:77,method", "setTimeout(()=>out({id:77,method").replace("params:{command:'npm install',reason:'needs network'}}); }", "params:{command:'npm install',reason:'needs network'}}),300); }")
    const p = runCodexServer({ cwd: process.cwd(), prompt: 'go', write: false, model: 'm', onEvent: () => {}, onHandle: (h) => h && (handle = h) }, fake(slow))
    for (let i = 0; i < 100 && !handle; i++) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 100))
    expect(await handle.steer('use tabs')).toBe(true)
    const r = await p
    expect(r.text).toBe('final: approval=decline steered=use tabs|U1')
  })

  it('reports a server that dies or never speaks as a protocol/auth problem, and a missing binary', async () => {
    const dead = await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm' }, fake(`console.error('Not logged in. Please log in again');process.exit(1)`))
    expect(dead).toMatchObject({ ok: false, error: { kind: 'auth' } })
    const silent = await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm' }, fake(`rl.on('line',()=>process.exit(0))`))
    expect(silent.error?.kind).toBe('protocol')
    expect((await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm' }, 'forge-no-such-codex')).error?.kind).toBe('missing')
  })

  it('failed turns carry the reason; abort interrupts', async () => {
    const failing = SERVER.replace("out({method:'turn/completed',params:{turn:{id:'U1',status:'completed'}}})", "out({method:'turn/completed',params:{turn:{id:'U1',status:'failed',error:{message:\"The 'x' model is not supported when using Codex with a ChatGPT account\"}}}})")
    const r = await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm', onApproval: async () => true }, fake(failing))
    expect(r).toMatchObject({ ok: false, error: { kind: 'model' } })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 150)
    const hang = fake(`rl.on('line',(l)=>{const m=JSON.parse(l); if(m.method==='initialize') out({id:m.id,result:{}}); else if(m.method==='thread/start') out({id:m.id,result:{thread:{id:'T'}}}); else if(m.method==='turn/start') out({id:m.id,result:{turn:{id:'U'}}})})`)
    const a = await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm', signal: ctl.signal }, hang)
    expect(a.error?.kind).toBe('aborted')
  })

  // a stand-in that reports how the thread was started, then asks for one approval and reports the answer
  const PROBE = `
rl.on('line',(l)=>{const m=JSON.parse(l);
 if(m.method==='initialize') out({id:m.id,result:{}});
 else if(m.method==='thread/start'){ started=m.params; out({id:m.id,result:{thread:{id:'T'}}}); }
 else if(m.method==='turn/start'){ out({id:m.id,result:{turn:{id:'U'}}}); out({id:5,method:'item/fileChange/requestApproval',params:{reason:'outside',grantRoot:'/home/u'}}); }
 else if(m.id===5){ out({method:'item/completed',params:{item:{type:'agentMessage',id:'m',text:JSON.stringify({policy:started.approvalPolicy,sandbox:started.sandbox,answer:m.result,args:process.argv.slice(2)}),phase:'final_answer'}}}); out({method:'turn/completed',params:{turn:{id:'U',status:'completed'}}}); }
});`
  const probe = (b: string) => fake(`let started=null;${b}`)

  it('a read-only run never gets approvals: the sandbox is the gate, so nothing can be accepted into a write', async () => {
    const r = await runCodexServer({ cwd: process.cwd(), prompt: 'review', write: false, model: 'm', web: false, onApproval: async () => true }, probe(PROBE))
    const seen = JSON.parse(r.text)
    expect(seen).toMatchObject({ policy: 'never', sandbox: 'read-only' })
    expect(seen.args).toEqual(expect.arrayContaining(['web_search="disabled"']))
    expect(seen.answer).toEqual({ decision: 'decline' }) // and if it asks anyway, the answer is no
  })

  it('declines when the caller throws or does not say a plain yes, and never grants a root', async () => {
    const write = (onApproval: any) => runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm', onApproval }, probe(PROBE))
    expect(JSON.parse((await write(async () => { throw new Error('boom') })).text)).toMatchObject({ policy: 'on-request', answer: { decision: 'decline' } })
    expect(JSON.parse((await write(async () => 'yes')).text).answer).toEqual({ decision: 'decline' })
    expect(JSON.parse((await write(async () => true)).text).answer).toEqual({ decision: 'accept' })
  })

  it('does not time out an agent while its approval waits for a person', async () => {
    const r = await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm', idleMs: 300, onApproval: () => new Promise((res) => setTimeout(() => res(true), 1000)) }, probe(PROBE))
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text).answer).toEqual({ decision: 'accept' })
  })

  it('keeps a character that arrives split across two reads', async () => {
    const split = fake(`rl.on('line',(l)=>{const m=JSON.parse(l);
 if(m.method==='initialize') out({id:m.id,result:{}});
 else if(m.method==='thread/start') out({id:m.id,result:{thread:{id:'T'}}});
 else if(m.method==='turn/start'){ out({id:m.id,result:{turn:{id:'U'}}});
   const b=Buffer.from(JSON.stringify({method:'item/completed',params:{item:{type:'agentMessage',id:'m',text:'na\\u00efve caf\\u00e9',phase:'final_answer'}}})+'\\n'+JSON.stringify({method:'turn/completed',params:{turn:{id:'U',status:'completed'}}})+'\\n');
   const cut=b.indexOf(0xc3)+1; process.stdout.write(b.subarray(0,cut)); setTimeout(()=>process.stdout.write(b.subarray(cut)),100); }
});`)
    expect((await runCodexServer({ cwd: process.cwd(), prompt: 'go', write: true, model: 'm' }, split)).text).toBe('naïve café')
  })
})
