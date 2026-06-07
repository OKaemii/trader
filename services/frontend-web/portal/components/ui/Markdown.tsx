'use client'
// Sanitized GFM markdown renderer for operator-authored notes (the notebook
// editor/preview, drawer notes, and the market-narrative panel all render through
// this one component). react-markdown turns the source into a React element tree —
// it never sets innerHTML — and we layer rehype-sanitize on top so even a raw
// `<script>`/`<img onerror=…>` smuggled into a note is stripped before render. The
// notes are operator-authored, but we sanitize anyway: a single hardened sink is
// cheaper to reason about than trusting every future call site.
//
//   <Markdown>{note.body}</Markdown>
//
// `children` is the markdown source string. Pass `className` to extend the wrapper's
// dark-theme defaults; element-level styling is fixed here so every surface renders
// notes identically.
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { cn } from './cn'

// Element → Tailwind class map. There is no @tailwindcss/typography plugin in this
// portal, so we style the generated nodes explicitly with the dark-mode design
// language (gray-950 page / emerald accents) instead of relying on `prose`.
const components: Parameters<typeof ReactMarkdown>[0]['components'] = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-5 text-lg font-semibold text-white first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 text-base font-semibold text-white first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-3 text-sm font-semibold text-gray-100 first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-3 text-sm leading-relaxed text-gray-300">{children}</p>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-gray-300">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-gray-300">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-gray-700 pl-3 text-sm italic text-gray-400">
      {children}
    </blockquote>
  ),
  code: ({ children, className: codeClassName }) => {
    // react-markdown tags fenced blocks with a `language-*` class and leaves inline
    // code class-less; we render inline code as a chip and let `pre` own block layout.
    const isBlock = Boolean(codeClassName)
    return (
      <code
        className={cn(
          'rounded bg-gray-800 px-1 py-0.5 font-mono text-xs text-emerald-300',
          isBlock && 'block bg-transparent px-0 py-0 text-gray-200',
        )}
      >
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded border border-gray-800 bg-gray-900 p-3 text-xs text-gray-200">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm text-gray-300">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-gray-700">{children}</thead>,
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold text-gray-200">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-gray-800 px-2 py-1">{children}</td>,
  hr: () => <hr className="my-4 border-gray-800" />,
  strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
}

export function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={cn('text-gray-300', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // rehype-sanitize runs over the HAST after remark→rehype, so any embedded
        // raw HTML (script tags, event-handler attributes, javascript: URLs) is
        // dropped against its default GitHub-derived allowlist before render.
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export default Markdown
