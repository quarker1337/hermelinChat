import { AMBER } from '../../theme/index.js'

interface HighlightedSnippetProps {
  text: string
}

export const HighlightedSnippet = ({ text }: HighlightedSnippetProps) => {
  const s = (text || '').toString()
  if (!s) return null

  const nodes: React.ReactNode[] = []
  let inside = false
  let buf = ''

  const flush = (kind: 'hit' | 'txt') => {
    if (!buf) return
    if (kind === 'hit') {
      nodes.push(
        <span key={nodes.length} style={{ color: AMBER[400] }}>
          {buf}
        </span>,
      )
    } else {
      nodes.push(<span key={nodes.length}>{buf}</span>)
    }
    buf = ''
  }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '[' && !inside) {
      flush('txt')
      inside = true
      continue
    }
    if (ch === ']' && inside) {
      flush('hit')
      inside = false
      continue
    }
    buf += ch
  }
  flush(inside ? 'hit' : 'txt')

  return <span>{nodes}</span>
}
