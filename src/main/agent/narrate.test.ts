import { describe, expect, it } from 'vitest'
import { describeTool, parsePlan } from './narrate'

describe('describeTool', () => {
  it('speaks plainly', () => {
    expect(describeTool('create_file', { path: 'src/app.js' })).toBe('Creating src/app.js')
    expect(describeTool('run_command', { command: 'npm test' })).toBe('Running the tests')
    expect(describeTool('run_command', { command: 'npm install left-pad' })).toBe('Installing packages')
    expect(describeTool('list_dir', { path: '.' })).toBe('Looking through the project')
    expect(describeTool('read_file', null)).toBe('Reading a file')
  })
})

describe('parsePlan', () => {
  it('reads markers, bullets and bare lines', () => {
    expect(parsePlan('[x] one\n- [>] two\n[ ] three\n4. four\n\n')).toEqual([
      { text: 'one', status: 'done' },
      { text: 'two', status: 'doing' },
      { text: 'three', status: 'todo' },
      { text: 'four', status: 'todo' },
    ])
  })
  it('caps the length', () => expect(parsePlan('x\n'.repeat(50))).toHaveLength(20))
})
