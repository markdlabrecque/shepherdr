import { expect, test } from 'bun:test'
import type { Chat } from '@shared/types.ts'
import { withoutPiHistory } from './reload.ts'

test('a build reload keeps drafts but waits for fresh Pi history', () => {
  const pi: Chat = { key: 'pi', cli: 'pi', messages: [] }
  const claude: Chat = { key: 'claude', cli: 'Claude Code', messages: [] }
  const quote = (id: string) => ({ id, text: `${id} quote` })
  const kept = { chats: { pi, claude }, reply: { pi: quote('pi'), claude: quote('claude') }, text: { pi: 'my draft' } }
  expect(withoutPiHistory(kept)).toEqual({ chats: { claude }, reply: { claude: quote('claude') }, text: kept.text })
})

test('a Pi reload cache with no saved quote keeps an empty reply map', () => {
  const pi: Chat = { key: 'pi', cli: 'pi', messages: [] }
  expect(withoutPiHistory({ chats: { pi } })).toEqual({ chats: {}, reply: {} })
})

test('a reload cache does not restore quotes from missing chats', () => {
  const text = { missing: 'saved draft' }
  const reply = { missing: { id: 'old', text: 'previous Pi branch' } }
  expect(withoutPiHistory({ reply, text })).toEqual({ chats: {}, reply: {}, text })
})
