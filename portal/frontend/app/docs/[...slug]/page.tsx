import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { notFound, redirect } from "next/navigation";
import DocViewer from "../DocViewer";

interface Props {
  params: Promise<{ slug: string[] }>;
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;

  // Docs live at <repo-root>/docs/ — two levels up from portal/frontend/
  const docsRoot = join(process.cwd(), "..", "..", "docs");
  const filePath = join(docsRoot, ...slug) + ".md";

  if (!existsSync(filePath)) {
    // If the slug is a directory (e.g. /docs/architecture), redirect to docs index
    const dirPath = join(docsRoot, ...slug);
    if (existsSync(dirPath)) {
      redirect("/docs");
    }
    notFound();
  }

  const content = readFileSync(filePath, "utf-8");

  return <DocViewer content={content} slug={slug} />;
}
