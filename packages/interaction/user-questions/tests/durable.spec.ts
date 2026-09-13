import { describe, expect, it } from 'vitest'
import { validateQuestionAnswer } from '../src/durable.ts'

describe('durable question answers', () => {
  const questions = [
    { id: 'a', question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: true },
    { id: 'b', question: 'Second?' },
  ]

  it('accepts a complete batch, multiple choices, custom text and explicit skips', () => {
    expect(() =>{  validateQuestionAnswer(questions, {
      answers: [{ id: 'b', selected: [], custom: 'Additional information' }, { id: 'a', selected: ['Yes', 'No'] }],
    }) }).not.toThrow()
  })

  it('rejects duplicate question identities and duplicate selected options', () => {
    expect(() =>{  validateQuestionAnswer(questions, {
      answers: [{ id: 'a', selected: [] }, { id: 'a', selected: [] }],
    }) }).toThrow('exactly once')
    expect(() =>{  validateQuestionAnswer(questions, {
      answers: [{ id: 'a', selected: ['Yes', 'Yes'] }, { id: 'b', selected: [] }],
    }) }).toThrow('does not match')
  })

  it('rejects a selected option when none was offered', () => {
    expect(() =>{  validateQuestionAnswer([questions[1]!], {
      answers: [{ id: 'b', selected: ['Unlisted'] }],
    }) }).toThrow('does not match')
  })
})
