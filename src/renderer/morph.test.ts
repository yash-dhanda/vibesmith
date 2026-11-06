// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { forget, keep, morph, morphChildren } from './morph'

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

  it('an island from keep() goes in as it is, and the next render keeps it untouched', () => {
    const live = host('<main><p>a</p></main>')
    const form = document.createElement('form'); form.innerHTML = '<textarea></textarea>'; form.querySelector('textarea')!.value = 'half-written'
    const next = el('<div><main><p>a</p></main></div>'); next.querySelector('main')!.append(keep('steer', form))
    morphChildren(live, next)
    expect(live.querySelector('form')).toBe(form); expect(live.querySelector('x-keep')).toBeNull()
    const again = el('<div><main><p>b</p></main></div>'); again.querySelector('main')!.append(keep('steer', form))
    morphChildren(live, again)
    expect(live.querySelector('form')).toBe(form); expect(form.querySelector('textarea')!.value).toBe('half-written'); expect(live.querySelector('p')!.textContent).toBe('b')
    forget()
  })

  it('leaves the value of the focused field alone, and updates the others', () => {
    const live = host('<div><input id="f" value="typed"><input id="g" value="old"></div>')
    const f = live.querySelector<HTMLInputElement>('#f')!; f.focus(); f.value = 'typing now'
    morphChildren(live, el('<div><div><input id="f" value="server"><input id="g" value="new"></div></div>'))
    expect(f.value).toBe('typing now')
    expect(live.querySelector<HTMLInputElement>('#g')!.value).toBe('new')
  })

  it('leaves an existing <details> as the person left it; a new one comes in as built', () => {
    const live = host('<details><summary>s</summary><p>x</p></details>')
    const d = live.querySelector('details')!
    morphChildren(live, el('<div><details open><summary>s</summary><p>y</p></details><details open data-key="n"><summary>n</summary></details></div>'))
    expect(live.querySelector('details')).toBe(d); expect(d.open).toBe(false); expect(d.querySelector('p')!.textContent).toBe('y')
    expect(live.querySelector<HTMLDetailsElement>('[data-key="n"]')!.open).toBe(true)
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

  it('keeps a data-sig widget whole while its signature holds, and swaps it when it changes', () => {
    const live = host('<article data-key="q" data-sig="1"><button>a</button></article>')
    const card = live.firstElementChild!, calls: string[] = []
    card.querySelector('button')!.onclick = () => calls.push('old')
    const same = el('<div><article data-key="q" data-sig="1"><button>b</button></article></div>'); same.querySelector('button')!.onclick = () => calls.push('new')
    morphChildren(live, same)
    expect(live.firstElementChild).toBe(card); card.querySelector('button')!.click(); expect(calls).toEqual(['old']); expect(card.textContent).toBe('a')
    morphChildren(live, el('<div><article data-key="q" data-sig="2"><button>c</button></article></div>'))
    expect(live.firstElementChild).not.toBe(card); expect(live.textContent).toBe('c')
  })

  it('leaves a data-hold node alone and never removes a data-transient one', () => {
    const live = host('<div data-key="r" data-hold><input class="edit"></div><div data-transient class="pop"></div>')
    const input = live.querySelector('input')!
    morphChildren(live, el('<div><div data-key="r"><span>title</span></div></div>'))
    expect(live.querySelector('input')).toBe(input); expect(live.querySelector('.pop')).not.toBeNull()
  })

  it('keeps typed values while the data is unchanged and takes new data when it changes', () => {
    const live = host('')
    morphChildren(live, el('<div><input value="Title"><input type="checkbox"></div>'))
    const [text, box] = Array.from(live.querySelectorAll('input'))
    text.value = 'Edited'; box.checked = true
    morphChildren(live, el('<div><input value="Title"><input type="checkbox"></div>'))
    expect(text.value).toBe('Edited'); expect(box.checked).toBe(true)
    morphChildren(live, el('<div><input value="Renamed"><input type="checkbox"></div>'))
    expect(text.value).toBe('Renamed')
  })

  it('keeps .enter and its style on a live node and never adds it to a node already there', () => {
    const live = host('<p class="row enter" style="--i: 2">a</p><p class="row">b</p>')
    const [a, b] = Array.from(live.querySelectorAll('p'))
    morphChildren(live, el('<div><p class="row">a</p><p class="row enter">b</p></div>'))
    expect(a.classList.contains('enter')).toBe(true); expect(a.getAttribute('style')).toContain('--i'); expect(b.classList.contains('enter')).toBe(false)
  })

  it('drops a keyed row first, so the rows that stay are not moved', () => {
    const live = host('<ol><li data-key="1">1</li><li data-key="2">2</li><li data-key="3">3</li></ol>')
    const [, two, three] = Array.from(live.querySelectorAll('li'))
    morphChildren(live, el('<div><ol><li data-key="2">2</li><li data-key="3">3</li><li data-key="4">4</li></ol></div>'))
    const after = Array.from(live.querySelectorAll('li'))
    expect(after[0]).toBe(two); expect(after[1]).toBe(three); expect(after.map((x) => x.textContent)).toEqual(['2', '3', '4'])
  })
})
