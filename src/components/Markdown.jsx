import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Markdown for assistant replies.
 *
 * The transcript used to render `msg.text` as a bare string, so the markdown
 * the model emits constantly — **bold**, bullet lists, fenced code — reached
 * the user as literal asterisks and backticks.
 *
 * Safety: react-markdown builds React elements rather than an HTML string, and
 * raw HTML in the source is NOT parsed because `rehype-raw` is deliberately not
 * installed. So a reply containing `<img onerror=...>` renders as visible text,
 * not as an element. Do not add rehype-raw here without a sanitiser.
 *
 * Only assistant text goes through this. What the user typed is shown verbatim,
 * so nobody's message is silently restyled by stray punctuation.
 */
export default function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links leave the app, so drop the opener reference with them.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          // react-markdown v9+ no longer passes `inline`; a fenced block is
          // wrapped in <pre>, so let the CSS distinguish the two instead of
          // guessing here.
          code: ({ node, className, children, ...props }) => (
            <code className={className} {...props}>{children}</code>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
