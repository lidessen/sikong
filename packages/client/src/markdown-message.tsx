import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownMessage(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="break-words">{children}</p>,
        a: ({ children, href }) => (
          <a
            className="text-primary underline underline-offset-2 hover:text-foreground"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {children}
          </a>
        ),
        h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
        h2: ({ children }) => <h2 className="text-[15px] font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
        ul: ({ children }) => <ul className="ml-4 list-disc [&>li+li]:mt-1">{children}</ul>,
        ol: ({ children }) => <ol className="ml-4 list-decimal [&>li+li]:mt-1">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-border-strong pl-3 text-muted-foreground">
            {children}
          </blockquote>
        ),
        code: ({ children, className }) => {
          const inline = !className;
          if (inline) {
            return (
              <code className="rounded-[var(--radius-sm)] border bg-background px-1 py-0.5 font-mono text-[12px]">
                {children}
              </code>
            );
          }
          return <code className={className}>{children}</code>;
        },
        pre: ({ children }) => (
          <pre className="overflow-auto rounded-[var(--radius-md)] border bg-background p-3 font-mono text-xs leading-5">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="overflow-auto rounded-[var(--radius-md)] border">
            <table className="w-full border-collapse text-left text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b bg-muted px-2 py-1.5 font-medium text-foreground">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border-b px-2 py-1.5 text-muted-foreground">{children}</td>
        ),
        hr: () => <div className="h-px bg-border" />,
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}
