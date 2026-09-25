import type { AccessLevel } from "@feedbacks/schema/enums";
import { toast } from "@feedbacks/ui";
import { useTranslation } from "react-i18next";

/** Reports the server outcome of a mutation (errors as toasts); resolves to true on success */
export function useReport() {
  const { t } = useTranslation();
  return (w: { server: Promise<{ type: string; error?: { message?: string } }> }, success?: string) =>
    w.server.then((r) => {
      if (r.type === "error") toast({ tone: "error", title: t("docs.actionFailed"), description: r.error?.message }, 6000);
      else if (success) toast({ title: success });
      return r.type !== "error";
    });
}

export const levelLabel = (t: (k: string) => string, level: AccessLevel | null) => (level ? t(`docs.level.${level}`) : "");
