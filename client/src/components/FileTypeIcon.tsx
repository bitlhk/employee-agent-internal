import { Archive, FileCode2, FileImage, FileText, Folder } from "lucide-react";

export type FileTypeIconKind = "directory" | "markdown" | "json" | "pdf" | "image" | "code" | "archive" | "file";

export function fileTypeIconKind(name: string, type: "file" | "directory" = "file"): FileTypeIconKind {
  if (type === "directory") return "directory";
  const extension = String(name || "").toLowerCase().split(".").pop();
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "json") return "json";
  if (extension === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension || "")) return "image";
  if (["py", "js", "jsx", "ts", "tsx", "css", "scss", "html", "htm", "sh", "bash", "sql", "xml", "yaml", "yml", "toml", "ini", "conf"].includes(extension || "")) return "code";
  if (["zip", "tar", "gz", "tgz", "rar", "7z"].includes(extension || "")) return "archive";
  return "file";
}

export function FileTypeIcon({
  name,
  type = "file",
}: {
  name: string;
  type?: "file" | "directory";
}) {
  const kind = fileTypeIconKind(name, type);
  if (kind === "directory") return <Folder className="workspace-tree-folder-icon" />;
  if (kind === "markdown") return <span className="workspace-tree-type workspace-tree-type--md">M↓</span>;
  if (kind === "json") return <span className="workspace-tree-type workspace-tree-type--json">{"{ }"}</span>;
  if (kind === "pdf") return <span className="workspace-tree-type workspace-tree-type--pdf">PDF</span>;
  if (kind === "image") return <FileImage className="workspace-tree-file-icon workspace-tree-file-icon--image" />;
  if (kind === "code") return <FileCode2 className="workspace-tree-file-icon workspace-tree-file-icon--code" />;
  if (kind === "archive") return <Archive className="workspace-tree-file-icon" />;
  return <FileText className="workspace-tree-file-icon" />;
}
