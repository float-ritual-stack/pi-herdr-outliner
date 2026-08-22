import { stripProperties } from "./properties";

export interface FileAnnotationInput {
  sourceBlockId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  comment: string;
}

export function formatFileAnnotation(input: FileAnnotationInput): string {
  const startLine = Math.max(1, Math.floor(input.startLine));
  const endLine = Math.max(startLine, Math.floor(input.endLine));
  const comment = input.comment.trim();
  if (!comment) throw new Error("Annotation comment cannot be empty");
  if (input.filePath.includes("]")) throw new Error("File paths containing ] cannot be represented as properties");

  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return [
    `Comment on ${input.filePath}:${range}`,
    `[type::annotation] [file::${input.filePath}] [line-start::${startLine}] [line-end::${endLine}] [source-block::${input.sourceBlockId}]`,
    comment,
  ].join("\n");
}

export function extractFileAnnotationComment(text: string): string {
  const lines = text.split(/\r?\n/);
  let commentStart = lines[0]?.startsWith("Comment on ") ? 1 : 0;
  while (commentStart < lines.length) {
    const line = lines[commentStart];
    if (line.trim() && stripProperties(line)) break;
    commentStart += 1;
  }
  return lines.slice(commentStart).join("\n").trim();
}
