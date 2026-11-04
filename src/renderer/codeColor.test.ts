import { describe, expect, it } from 'vitest'
import { liteColor } from './codeColor'

describe('liteColor', () => {
  it('marks keywords, strings, comments and numbers, and escapes the rest', () => {
    expect(liteColor(`const a = "x<y" // hi\nreturn 42`, 'a.ts')).toBe('<span class="tk-k">const</span> a = <span class="tk-s">"x&lt;y"</span> <span class="tk-c">// hi</span>\n<span class="tk-k">return</span> <span class="tk-n">42</span>')
  })
  it('handles python, json, css and html', () => {
    expect(liteColor(`def f(): # c`, 'a.py')).toBe('<span class="tk-k">def</span> f(): <span class="tk-c"># c</span>')
    expect(liteColor(`{"a": true, "b": 1}`, 'x.json')).toBe('{<span class="tk-s">"a"</span>: <span class="tk-k">true</span>, <span class="tk-s">"b"</span>: <span class="tk-n">1</span>}')
    expect(liteColor(`a { color: #fff; }`, 's.css')).toBe('a { <span class="tk-t">color</span>: <span class="tk-n">#fff</span>; }')
    expect(liteColor(`<a href="x">`, 'i.html')).toBe('<span class="tk-k">&lt;a</span> <span class="tk-t">href</span>=<span class="tk-s">"x"</span><span class="tk-k">&gt;</span>')
  })
  it('leaves unknown files as escaped text', () => {
    expect(liteColor('<b> & c', 'notes.txt')).toBe('&lt;b&gt; &amp; c')
  })
})
