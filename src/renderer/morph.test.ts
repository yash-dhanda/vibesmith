// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { morph, morphChildren } from './morph'

const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild as HTMLElement }
const host = (html: string) => { const d = document.createElement('div'); d.innerHTML = html.trim(); document.body.replaceChildren(d); return d }

describe('morph', () => {
  it('keeps nodes that are still there and changes only text and attributes', () => {
    const live = host('<section class="a"><h1>Old</h1><p title="x">one</p></section>')
    const h1 = live.querySelector('h1')!, p = live.querySelector('p')!
    morphChildren(live, el('<div><section class="b"><h1>New</h1><p title="y">one</p></section></div>'))
    expect(live.querySelector('h1')).toBe(h1)
    expect(live.querySelector('p')).toBe(p)
    expect(h1.textContent).toBe('New')
    expect(p.title).toBe('y')
    expect(live.querySelector('section')!.className).toBe('b')
  })

  it('matches keyed items when they move, are added or removed, without rebuilding the others', () => {
    const live = host('<ul><li data-key="a">A</li><li data-key="b">B</li><li data-key="c">C</li></ul>')
    const [a, b, c] = Array.from(live.querySelectorAll('li'))
    morphChildren(live, el('<div><ul><li data-key="c">C2</li><li data-key="d">D</li><li data-key="a">A</li></ul></div>'))
    const after = Array.from(live.querySelectorAll('li'))
    expect(after.map((x) => x.textContent)).toEqual(['C2', 'D', 'A'])
    expect(after[0]).toBe(c)
    expect(after[2]).toBe(a)
    expect(b.isConnected).toBe(false)
  })

  it('removes attributes and extra children the new tree does not have', () => {
    const live = host('<div class="x" data-old="1"><span>1</span><span>2</span><span>3</span></div>')
    morphChildren(live, el('<div><div class="x"><span>1</span></div></div>'))
    expect(live.firstElementChild!.hasAttribute('data-old')).toBe(false)
    expect(live.querySelectorAll('span').length).toBe(1)
  })

  it('copies property handlers so a kept button calls the newest code', () => {
    const live = host('<button>go</button>')
    const calls: string[] = []
    const first = live.querySelector('button')!; first.onclick = () => calls.push('old')
    const next = el('<div><button>go</button></div>'); next.querySelector('button')!.onclick = () => calls.push('new')
    morphChildren(live, next)
    expect(live.querySelector('button')).toBe(first)
    first.click()
    expect(calls).toEqual(['new'])
  })

  it('a node marked data-keep is moved in as it is and never patched', () => {
    const live = host('<main><p>a</p></main>')
    const kept = document.createElement('form'); kept.setAttribute('data-keep', ''); kept.innerHTML = '<textarea></textarea>'
    const area = kept.querySelector('textarea')!; area.value = 'half-written'
    const next = el('<div><main><p>a</p></main></div>'); next.querySelector('main')!.append(kept)
    morphChildren(live, next)
    expect(live.querySelector('form')).toBe(kept)
    expect(live.querySelector('textarea')!.value).toBe('half-written')
    // the next render takes the same node again: it stays, with its content
    const again = el('<div><main><p>b</p></main></div>'); again.querySelector('main')!.append(kept)
    morphChildren(live, again)
    expect(live.querySelector('form')).toBe(kept)
    expect(live.querySelector('p')!.textContent).toBe('b')
  })

  it('leaves the value of the focused field alone, and updates the others', () => {
    const live = host('<div><input id="f" value="typed"><input id="g" value="old"></div>')
    const f = live.querySelector<HTMLInputElement>('#f')!; f.focus(); f.value = 'typing now'
    morphChildren(live, el('<div><div><input id="f" value="server"><input id="g" value="new"></div></div>'))
    expect(f.value).toBe('typing now')
    expect(live.querySelector<HTMLInputElement>('#g')!.value).toBe('new')
  })

  it('keeps a <details> state from the new tree and does not swap the element', () => {
    const live = host('<details><summary>s</summary><p>x</p></details>')
    const d = live.querySelector('details')!
    const next = el('<div><details open><summary>s</summary><p>y</p></details></div>')
    morphChildren(live, next)
    expect(live.querySelector('details')).toBe(d)
    expect(d.open).toBe(true)
    expect(d.querySelector('p')!.textContent).toBe('y')
  })

  it('swaps an element for one of another kind', () => {
    const live = host('<p>x</p>')
    morphChildren(live, el('<div><h2>y</h2></div>'))
    expect(live.innerHTML).toBe('<h2>y</h2>')
    const root = live.querySelector('h2')!
    morph(root, el('<div><section>z</section></div>').firstElementChild as HTMLElement)
    expect(live.innerHTML).toBe('<section>z</section>')
  })

  it('sets a select to the new value after its options change', () => {
    const live = host('<select><option value="a">A</option></select>')
    const next = el('<div><select><option value="a">A</option><option value="b">B</option></select></div>')
    next.querySelector('select')!.value = 'b'
    morphChildren(live, next)
    expect(live.querySelector('select')!.value).toBe('b')
  })
})
