import { useCallback, useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/confirmation-dialog";

type ConfirmVariant = "default" | "danger";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;
};

type PendingConfirm = Required<Pick<ConfirmOptions, "title" | "confirmText" | "cancelText" | "variant">> & {
  description?: string;
  resolve: (confirmed: boolean) => void;
};

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({
        title: options.title,
        description: options.description,
        confirmText: options.confirmText || "确认",
        cancelText: options.cancelText || "取消",
        variant: options.variant || "default",
        resolve,
      });
    });
  }, []);

  const close = useCallback((confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  const dialog = useMemo(() => (
    <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) close(false); }}>
      <AlertDialogContent className="bg-white text-gray-900 border-gray-200 shadow-xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-gray-900">{pending?.title || "确认操作"}</AlertDialogTitle>
          {pending?.description ? (
            <AlertDialogDescription className="whitespace-pre-line text-gray-600">
              {pending.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            className="border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:text-gray-900"
            onClick={() => close(false)}
          >
            {pending?.cancelText || "取消"}
          </AlertDialogCancel>
          <AlertDialogAction
            className={pending?.variant === "danger"
              ? "bg-red-600 text-white hover:bg-red-700"
              : "bg-red-600 text-white hover:bg-red-700"}
            onClick={() => close(true)}
          >
            {pending?.confirmText || "确认"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ), [close, pending]);

  return { confirm, dialog };
}
