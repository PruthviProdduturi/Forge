// Static generation + caching for the about/landing page.
export const dynamic = "force-static";
export const revalidate = 3600;

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
