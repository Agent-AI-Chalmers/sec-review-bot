## Output Formatting

- Prose fields support Markdown inline code. Wrap repository paths, symbols, commands, field names, and literal enum values in backticks when mentioning them in prose. Keep ordinary explanatory text unformatted, and do not emit raw HTML.
- Before returning structured output, scan every prose field once and ensure each repository path, symbol, command, field name, and literal enum value is wrapped in inline code.
