import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema } from '../editor/schema'
import { cursorFromTextBefore } from '@/utils/editorCursor'

function cursorAtTextOffset(text: string, offset: number) {
  const doc = schema.node('doc', null, text.split('\n').map(line =>
    schema.node('paragraph', null, line ? [schema.text(line)] : undefined),
  ))
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, offset),
  })
  const textBefore = state.doc.textBetween(0, state.selection.head, '\n', '\n')
  return cursorFromTextBefore(textBefore)
}

describe('ProseMirror cursor position projection', () => {
  it('computes initial cursor position from the visible text projection', () => {
    expect(cursorAtTextOffset('hello', 1)).toEqual({ line: 1, column: 1 })
  })

  it('computes line and column across multiple paragraphs', () => {
    expect(cursorAtTextOffset('one\ntwo', 7)).toEqual({ line: 2, column: 2 })
  })
})
