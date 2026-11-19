declare module '*.css' {}
declare module '*.jsonl?raw' {
  const content: string
  export default content
}
