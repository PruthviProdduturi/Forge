import { useAuth } from "../auth/useAuth";

export function useRole() {
  const { role } = useAuth();
  return {
    role,
    isAdmin: role === "Admin",
    isEditor: role === "Editor" || role === "Admin",
    isAnalyst: role === "Analyst" || role === "Editor" || role === "Admin",
    isViewer: !!role,
  };
}
