import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/action-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
import { Building2, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

type SpaceStatus = "active" | "disabled";
type ProfileStatus = "pending" | "active" | "disabled";
type Section = "spaces" | "members";

type SpaceForm = {
  name: string;
  description: string;
  status: SpaceStatus;
  sortOrder: number;
};

type MemberForm = {
  userId: number;
  realName: string;
  organizationName: string;
  departmentName: string;
  teamName: string;
  spaceId: number | null;
  status: ProfileStatus;
  notes: string;
};

const T = {
  spacesTab: "\u534f\u4f5c\u7a7a\u95f4",
  membersTab: "\u534f\u4f5c\u6210\u5458",
  created: "\u534f\u4f5c\u7a7a\u95f4\u5df2\u521b\u5efa",
  updated: "\u534f\u4f5c\u7a7a\u95f4\u5df2\u66f4\u65b0",
  profileUpdated: "\u6210\u5458\u534f\u4f5c\u8eab\u4efd\u5df2\u66f4\u65b0",
  bulkUpdated: "\u5df2\u6279\u91cf\u66f4\u65b0\u6210\u5458",
  deleted: "\u534f\u4f5c\u7a7a\u95f4\u5df2\u5220\u9664",
  createFailed: "\u521b\u5efa\u5931\u8d25",
  updateFailed: "\u66f4\u65b0\u5931\u8d25",
  deleteFailed: "\u5220\u9664\u5931\u8d25",
  nameTooShort: "\u7a7a\u95f4\u540d\u79f0\u81f3\u5c11 2 \u4e2a\u5b57",
  disableSpaceTitle: "\u786e\u8ba4\u7981\u7528\u534f\u4f5c\u7a7a\u95f4",
  riskyMemberTitle: "\u786e\u8ba4\u8c03\u6574\u6210\u5458\u534f\u4f5c\u6743\u9650",
  confirm: "\u786e\u8ba4",
  cancel: "\u53d6\u6d88",
  members: "\u6210\u5458",
  activeSessions: "\u8fdb\u884c\u4e2d",
  pendingInvites: "\u5f85\u63a5\u53d7",
  pageTitle: "\u7ec4\u7ec7\u534f\u4f5c\u6743\u9650",
  pageDesc: "\u7528\u534f\u4f5c\u7a7a\u95f4\u7ba1\u7406\u5ba2\u6237\u95f4\u7684\u786c\u9694\u79bb\uff0c\u7528\u7075\u867e\u6210\u5458\u6863\u6848\u7ba1\u7406\u771f\u540d\u3001\u516c\u53f8/\u7ec4\u7ec7\u3001\u90e8\u95e8/\u5c0f\u7ec4\u548c\u534f\u4f5c\u51c6\u5165\u3002\u8fd9\u4efd\u6863\u6848\u4e5f\u662f\u540e\u7eed\u667a\u80fd\u4f53\u4e0e\u4efb\u52a1\u6743\u9650\u7684\u57fa\u7840\u3002",
  refresh: "\u5237\u65b0",
  create: "\u65b0\u5efa",
  loading: "\u52a0\u8f7d\u4e2d",
  emptySpaces: "\u6682\u65e0\u534f\u4f5c\u7a7a\u95f4",
  enabled: "\u542f\u7528",
  disabled: "\u505c\u7528",
  pending: "\u5f85\u5ba1\u6279",
  active: "\u5df2\u51c6\u5165",
  newTitle: "\u65b0\u5efa\u534f\u4f5c\u7a7a\u95f4",
  chooseTitle: "\u9009\u62e9\u534f\u4f5c\u7a7a\u95f4",
  detailDesc: "\u7f16\u8f91\u7a7a\u95f4\u57fa\u7840\u4fe1\u606f\u3002\u6210\u5458\u7ba1\u7406\u5728\u4e0a\u65b9\u5207\u6362\u5230\u534f\u4f5c\u6210\u5458\u3002",
  chooseHint: "\u8bf7\u9009\u62e9\u5de6\u4fa7\u7a7a\u95f4\uff0c\u6216\u65b0\u5efa\u4e00\u4e2a\u534f\u4f5c\u7a7a\u95f4\u3002",
  name: "\u7a7a\u95f4\u540d\u79f0",
  namePlaceholder: "\u4f8b\u5982\uff1a\u5148\u9063\u961f\u91d1\u878d\u4e2d\u961f",
  status: "\u72b6\u6001",
  sort: "\u6392\u5e8f",
  description: "\u8bf4\u660e",
  descriptionPlaceholder: "\u7528\u4e8e\u8bf4\u660e\u8be5\u7a7a\u95f4\u8986\u76d6\u7684\u7ec4\u7ec7\u3001\u5ba2\u6237\u6216\u8bd5\u70b9\u8303\u56f4",
  createSpace: "\u521b\u5efa\u7a7a\u95f4",
  save: "\u4fdd\u5b58\u4fee\u6539",
  searchMembers: "\u641c\u7d22\u59d3\u540d\u3001\u90ae\u7bb1\u3001\u7ec4\u7ec7\u6216\u90e8\u95e8",
  editMember: "\u7f16\u8f91\u6210\u5458",
  realName: "\u771f\u5b9e\u59d3\u540d",
  organization: "\u516c\u53f8 / \u7ec4\u7ec7",
  department: "\u90e8\u95e8",
  team: "\u5c0f\u7ec4",
  space: "\u534f\u4f5c\u7a7a\u95f4",
  noneSpace: "\u672a\u5206\u914d",
  notes: "\u5907\u6ce8",
  batchAssign: "\u6279\u91cf\u5206\u914d",
  selected: "\u5df2\u9009",
  spaceMembers: "\u7a7a\u95f4\u6210\u5458",
  emptySpaceMembers: "\u8be5\u7a7a\u95f4\u6682\u65e0\u6210\u5458",
  deleteSpace: "\u5220\u9664\u7a7a\u95f4",
  deleteSpaceTitle: "\u786e\u8ba4\u5220\u9664\u534f\u4f5c\u7a7a\u95f4",
  deleteSpaceBlocked: "\u53ea\u6709\u6ca1\u6709\u6210\u5458\u3001\u8fdb\u884c\u4e2d\u4f1a\u8bdd\u548c\u5f85\u63a5\u53d7\u9080\u8bf7\u7684\u7a7a\u95f4\u624d\u80fd\u5220\u9664",
};

const emptyForm: SpaceForm = {
  name: "",
  description: "",
  status: "active",
  sortOrder: 99,
};

const emptyMemberForm: MemberForm = {
  userId: 0,
  realName: "",
  organizationName: "",
  departmentName: "",
  teamName: "",
  spaceId: null,
  status: "pending",
  notes: "",
};

function statusLabel(status: ProfileStatus | SpaceStatus) {
  if (status === "active") return T.active;
  if (status === "disabled") return T.disabled;
  return T.pending;
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "disabled") return "secondary";
  return "outline";
}

export function CollaborationTab() {
  const [section, setSection] = useState<Section>("spaces");
  const [selectedId, setSelectedId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<SpaceForm>(emptyForm);
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [editingMember, setEditingMember] = useState<any | null>(null);
  const [memberForm, setMemberForm] = useState<MemberForm>(emptyMemberForm);
  const [bulkSpaceId, setBulkSpaceId] = useState<string>("keep");
  const [bulkStatus, setBulkStatus] = useState<string>("keep");
  const [confirmState, setConfirmState] = useState<null | { title: string; description: string; onConfirm: () => void }>(null);

  const utils = trpc.useUtils();
  const { data, isLoading, refetch, isFetching } = trpc.collabSpaces.list.useQuery();
  const shouldLoadMembers = section === "members" || typeof selectedId === "number";
  const { data: memberData, isLoading: membersLoading, isFetching: membersFetching, refetch: refetchMembers } = trpc.collabMembers.list.useQuery(undefined, { enabled: shouldLoadMembers });
  const membersBusy = membersLoading || membersFetching;
  const spaces = Array.isArray(data) ? data : [];
  const members = Array.isArray(memberData) ? memberData : [];

  const selectedSpace = useMemo(() => {
    if (typeof selectedId !== "number") return null;
    return spaces.find((space) => space.id === selectedId) || null;
  }, [selectedId, spaces]);

  useEffect(() => {
    if (typeof selectedId === "number") {
      void refetchMembers();
    }
  }, [selectedId, refetchMembers]);

  const selectedSpaceMembers = useMemo(() => {
    if (!selectedSpace) return [];
    return members.filter((member: any) => member.spaceId === selectedSpace.id && member.status === "active");
  }, [members, selectedSpace]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((member: any) => [
      member.name,
      member.email,
      member.realName,
      member.organizationName,
      member.departmentName,
      member.teamName,
      member.spaceName,
    ].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [memberSearch, members]);

  useEffect(() => {
    if (!selectedId && spaces.length > 0) {
      setSelectedId(spaces[0].id);
    }
  }, [selectedId, spaces]);

  useEffect(() => {
    if (selectedId === "new") {
      setForm(emptyForm);
      return;
    }
    if (selectedSpace) {
      setForm({
        name: selectedSpace.name || "",
        description: selectedSpace.description || "",
        status: selectedSpace.status as SpaceStatus,
        sortOrder: selectedSpace.sortOrder ?? 99,
      });
    }
  }, [selectedId, selectedSpace]);

  const invalidateAll = async () => {
    await Promise.all([
      utils.collabSpaces.list.invalidate(),
      utils.collabMembers.list.invalidate(),
    ]);
  };

  const createMutation = trpc.collabSpaces.create.useMutation({
    onSuccess: async (space) => {
      toast.success(T.created);
      await invalidateAll();
      setSelectedId(space.id);
    },
    onError: (error) => toast.error(`${T.createFailed}: ${error.message}`),
  });

  const updateMutation = trpc.collabSpaces.update.useMutation({
    onSuccess: async () => {
      toast.success(T.updated);
      await invalidateAll();
    },
    onError: (error) => toast.error(`${T.updateFailed}: ${error.message}`),
  });

  const deleteMutation = trpc.collabSpaces.delete.useMutation({
    onSuccess: async () => {
      toast.success(T.deleted);
      setSelectedId(null);
      await invalidateAll();
    },
    onError: (error) => toast.error(`${T.deleteFailed}: ${error.message}`),
  });

  const updateMemberMutation = trpc.collabMembers.update.useMutation({
    onSuccess: async () => {
      toast.success(T.profileUpdated);
      setEditingMember(null);
      await invalidateAll();
    },
    onError: (error) => toast.error(`${T.updateFailed}: ${error.message}`),
  });

  const bulkUpdateMutation = trpc.collabMembers.bulkUpdate.useMutation({
    onSuccess: async () => {
      toast.success(T.bulkUpdated);
      setSelectedUserIds([]);
      await invalidateAll();
    },
    onError: (error) => toast.error(`${T.updateFailed}: ${error.message}`),
  });

  const saving = createMutation.isPending || updateMutation.isPending;

  const persistSpace = (payload: SpaceForm & { name: string }) => {
    if (selectedId === "new" || selectedId === null) {
      createMutation.mutate(payload);
    } else {
      updateMutation.mutate({ id: selectedId, ...payload });
    }
  };

  const handleSaveSpace = () => {
    const name = form.name.trim();
    if (name.length < 2) {
      toast.error(T.nameTooShort);
      return;
    }

    const payload = {
      name,
      description: form.description.trim(),
      status: form.status,
      sortOrder: Number.isFinite(form.sortOrder) ? form.sortOrder : 99,
    };

    if (selectedId !== "new" && selectedSpace && selectedSpace.status === "active" && form.status === "disabled") {
      setConfirmState({
        title: T.disableSpaceTitle,
        description: `${selectedSpace.name}: ${selectedSpace.memberCount} ${T.members}, ${selectedSpace.activeSessionCount} ${T.activeSessions} session, ${selectedSpace.pendingInviteCount} ${T.pendingInvites}. ${T.disabled}`,
        onConfirm: () => persistSpace(payload),
      });
      return;
    }

    persistSpace(payload);
  };

  const handleDeleteSpace = () => {
    if (!selectedSpace) return;
    const blocked = (selectedSpace.memberCount || 0) > 0 || (selectedSpace.activeSessionCount || 0) > 0 || (selectedSpace.pendingInviteCount || 0) > 0;
    if (blocked) {
      toast.error(T.deleteSpaceBlocked);
      return;
    }
    setConfirmState({
      title: T.deleteSpaceTitle,
      description: `${selectedSpace.name}: 0 ${T.members}, 0 ${T.activeSessions}, 0 ${T.pendingInvites}.`,
      onConfirm: () => deleteMutation.mutate({ id: selectedSpace.id }),
    });
  };

  const openEditMember = (member: any) => {
    setEditingMember(member);
    setMemberForm({
      userId: member.id,
      realName: member.realName || member.name || "",
      organizationName: member.organizationName || "",
      departmentName: member.departmentName || "",
      teamName: member.teamName || "",
      spaceId: member.spaceId ?? null,
      status: member.status || "pending",
      notes: member.notes || "",
    });
  };

  const persistMember = () => {
    updateMemberMutation.mutate(memberForm);
  };

  const handleSaveMember = () => {
    if (!editingMember) return;
    const risky = (editingMember.activeSessionCount || 0) > 0 || (editingMember.pendingInviteCount || 0) > 0;
    const movingSpace = (editingMember.spaceId ?? null) !== memberForm.spaceId;
    const disabling = editingMember.status !== "disabled" && memberForm.status === "disabled";
    if (risky && (movingSpace || disabling)) {
      setConfirmState({
        title: T.riskyMemberTitle,
        description: `${editingMember.realName || editingMember.name || editingMember.email}: ${editingMember.activeSessionCount || 0} ${T.activeSessions}, ${editingMember.pendingInviteCount || 0} ${T.pendingInvites}.`,
        onConfirm: persistMember,
      });
      return;
    }
    persistMember();
  };

  const handleBulkUpdate = () => {
    if (selectedUserIds.length === 0) return;
    const payload: { userIds: number[]; spaceId?: number | null; status?: ProfileStatus } = { userIds: selectedUserIds };
    if (bulkSpaceId !== "keep") payload.spaceId = bulkSpaceId === "none" ? null : Number(bulkSpaceId);
    if (bulkStatus !== "keep") payload.status = bulkStatus as ProfileStatus;
    if (!("spaceId" in payload) && !payload.status) return;

    const selectedRows = members.filter((member: any) => selectedUserIds.includes(member.id));
    const riskyCount = selectedRows.filter((member: any) => (member.activeSessionCount || 0) > 0 || (member.pendingInviteCount || 0) > 0).length;
    if (riskyCount > 0) {
      setConfirmState({
        title: T.riskyMemberTitle,
        description: `${riskyCount} ${T.members} ${T.activeSessions}/${T.pendingInvites} > 0.`,
        onConfirm: () => bulkUpdateMutation.mutate(payload),
      });
      return;
    }
    bulkUpdateMutation.mutate(payload);
  };

  const toggleSelected = (userId: number) => {
    setSelectedUserIds((prev) => prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]);
  };

  const selectedStats = selectedSpace
    ? [
        { label: T.members, value: selectedSpace.memberCount, icon: Users },
        { label: T.activeSessions, value: selectedSpace.activeSessionCount, icon: ShieldCheck },
        { label: T.pendingInvites, value: selectedSpace.pendingInviteCount, icon: RefreshCw },
      ]
    : [];

  return (
    <div className="admin-collaboration-tab space-y-6">
      <Card className="admin-collaboration-card">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{T.pageTitle}</CardTitle>
            <CardDescription>{T.pageDesc}</CardDescription>
          </div>
          <Button variant="outline" onClick={() => { refetch(); refetchMembers(); }} disabled={isFetching} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            {T.refresh}
          </Button>
        </CardHeader>
      </Card>

      <div className="admin-collaboration-switcher flex flex-wrap gap-2 rounded-xl border p-2">
        <Button variant={section === "spaces" ? "default" : "ghost"} onClick={() => setSection("spaces")} className="gap-2">
          <Building2 className="h-4 w-4" />
          {T.spacesTab}
        </Button>
        <Button variant={section === "members" ? "default" : "ghost"} onClick={() => setSection("members")} className="gap-2">
          <Users className="h-4 w-4" />
          {T.membersTab}
        </Button>
      </div>

      {section === "spaces" ? (
        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="admin-collaboration-card">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{T.spacesTab}</CardTitle>
                  <CardDescription>{T.pageDesc}</CardDescription>
                </div>
                <Button size="sm" onClick={() => setSelectedId("new")} className="gap-1">
                  <Plus className="h-4 w-4" />
                  {T.create}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {isLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  {T.loading}
                </div>
              ) : spaces.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {T.emptySpaces}
                </div>
              ) : (
                spaces.map((space) => {
                  const active = selectedId === space.id;
                  return (
                    <button
                      key={space.id}
                      type="button"
                      onClick={() => setSelectedId(space.id)}
                      className="admin-collaboration-space-button w-full rounded-xl border p-3 text-left transition"
                      aria-current={active ? "true" : undefined}
                      data-active={active ? "true" : "false"}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{space.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {space.memberCount} {T.members} - {space.activeSessionCount} {T.activeSessions}
                          </div>
                        </div>
                        <Badge variant={space.status === "active" ? "default" : "secondary"}>
                          {space.status === "active" ? T.enabled : T.disabled}
                        </Badge>
                      </div>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="admin-collaboration-card">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Building2 className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>{selectedId === "new" ? T.newTitle : selectedSpace?.name || T.chooseTitle}</CardTitle>
                  <CardDescription>{T.detailDesc}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {!selectedId ? (
                <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
                  {T.chooseHint}
                </div>
              ) : (
                <>
                  {selectedSpace && (
                    <>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {selectedStats.map((item) => {
                          const Icon = item.icon;
                          return (
                            <div key={item.label} className="rounded-xl border border-gray-200 bg-white p-4">
                              <div className="flex items-center gap-2 text-sm text-gray-500">
                                <Icon className="h-4 w-4" />
                                {item.label}
                              </div>
                              <div className="mt-2 text-2xl font-semibold text-gray-900">{item.value}</div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-gray-900">{T.spaceMembers}</div>
                          <Badge variant="outline">{membersBusy ? "..." : selectedSpaceMembers.length}</Badge>
                        </div>
                        {membersBusy ? (
                          <div className="flex items-center text-sm text-muted-foreground">
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            {T.loading}
                          </div>
                        ) : selectedSpaceMembers.length === 0 ? (
                          <div className="text-sm text-gray-500">{T.emptySpaceMembers}</div>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {selectedSpaceMembers.map((member: any) => (
                              <div key={member.id} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                                <div className="truncate text-sm font-medium text-gray-900">{member.realName || member.name || member.email || `User ${member.id}`}</div>
                                <div className="truncate text-xs text-gray-500">{member.organizationName || "-"} · {member.departmentName || "-"} · {member.teamName || "-"}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="collab-space-name">{T.name}</Label>
                      <Input id="collab-space-name" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder={T.namePlaceholder} />
                    </div>
                    <div className="space-y-2">
                      <Label>{T.status}</Label>
                      <Select value={form.status} onValueChange={(value: SpaceStatus) => setForm((prev) => ({ ...prev, status: value }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">{T.enabled}</SelectItem>
                          <SelectItem value="disabled">{T.disabled}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="collab-space-sort">{T.sort}</Label>
                      <Input id="collab-space-sort" type="number" value={form.sortOrder} onChange={(event) => setForm((prev) => ({ ...prev, sortOrder: Number(event.target.value) }))} />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="collab-space-description">{T.description}</Label>
                      <Textarea id="collab-space-description" value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} placeholder={T.descriptionPlaceholder} rows={4} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                    <div>
                      {selectedSpace && (
                        <Button
                          variant="outline"
                          onClick={handleDeleteSpace}
                          disabled={(selectedSpace.memberCount || 0) > 0 || (selectedSpace.activeSessionCount || 0) > 0 || (selectedSpace.pendingInviteCount || 0) > 0 || deleteMutation.isPending}
                          title={T.deleteSpaceBlocked}
                          className="gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" />
                          {T.deleteSpace}
                        </Button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-3">
                      <Button variant="outline" onClick={() => selectedSpace ? setSelectedId(selectedSpace.id) : setSelectedId(null)}>{T.cancel}</Button>
                    <Button onClick={handleSaveSpace} disabled={saving} className="gap-2">
                      {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
                      {selectedId === "new" ? T.createSpace : T.save}
                    </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card className="admin-collaboration-card">
          <CardHeader>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle>{T.membersTab}</CardTitle>
                <CardDescription>{T.pageDesc}</CardDescription>
              </div>
              <div className="relative w-full lg:w-80">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-9" value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder={T.searchMembers} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedUserIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 p-3">
                <Badge variant="secondary">{T.selected} {selectedUserIds.length}</Badge>
                <Select value={bulkSpaceId} onValueChange={setBulkSpaceId}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keep">{T.space}: -</SelectItem>
                    <SelectItem value="none">{T.noneSpace}</SelectItem>
                    {spaces.map((space) => <SelectItem key={space.id} value={String(space.id)}>{space.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={bulkStatus} onValueChange={setBulkStatus}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keep">{T.status}: -</SelectItem>
                    <SelectItem value="pending">{T.pending}</SelectItem>
                    <SelectItem value="active">{T.active}</SelectItem>
                    <SelectItem value="disabled">{T.disabled}</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={handleBulkUpdate} disabled={bulkUpdateMutation.isPending}>{T.batchAssign}</Button>
              </div>
            )}

            {membersBusy ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />{T.loading}</div>
            ) : (
              <div className="overflow-hidden rounded-xl border">
                <div className="grid grid-cols-[44px_minmax(170px,1.1fr)_minmax(120px,0.8fr)_minmax(150px,1fr)_minmax(130px,0.8fr)_140px_110px_110px] border-b bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
                  <div />
                  <div>{T.members}</div>
                  <div>{T.organization}</div>
                  <div>{T.department}</div>
                  <div>{T.team}</div>
                  <div>{T.space}</div>
                  <div>{T.status}</div>
                  <div />
                </div>
                <div className="divide-y">
                  {filteredMembers.map((member: any) => (
                    <div key={member.id} className="grid grid-cols-[44px_minmax(170px,1.1fr)_minmax(120px,0.8fr)_minmax(150px,1fr)_minmax(130px,0.8fr)_140px_110px_110px] items-center gap-2 px-3 py-3 text-sm">
                      <input type="checkbox" className="h-4 w-4 rounded border-border" checked={selectedUserIds.includes(member.id)} onChange={() => toggleSelected(member.id)} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{member.realName || member.name || member.email || `User ${member.id}`}</div>
                        <div className="truncate text-xs text-muted-foreground">#{member.id} {member.email || ""}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate">{member.organizationName || "-"}</div>
                      </div>
                      <div className="truncate">{member.departmentName || "-"}</div>
                      <div className="truncate">{member.teamName || "-"}</div>
                      <div className="truncate">{member.spaceName || T.noneSpace}</div>
                      <div><Badge variant={statusVariant(member.status)}>{statusLabel(member.status)}</Badge></div>
                      <div className="flex justify-end">
                        <Button variant="outline" size="sm" onClick={() => openEditMember(member)} className="gap-1"><Pencil className="h-3.5 w-3.5" />{T.editMember}</Button>
                      </div>
                    </div>
                  ))}
                  {filteredMembers.length === 0 && <div className="p-10 text-center text-muted-foreground">{T.emptySpaces}</div>}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent className="sm:max-w-2xl border-gray-200 bg-white text-gray-900 shadow-2xl">
          <DialogHeader>
            <DialogTitle>{T.editMember}</DialogTitle>
            <DialogDescription>{editingMember?.email || editingMember?.name}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label>{T.realName}</Label><Input value={memberForm.realName} onChange={(event) => setMemberForm((prev) => ({ ...prev, realName: event.target.value }))} /></div>
            <div className="space-y-2"><Label>{T.status}</Label><Select value={memberForm.status} onValueChange={(value: ProfileStatus) => setMemberForm((prev) => ({ ...prev, status: value }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pending">{T.pending}</SelectItem><SelectItem value="active">{T.active}</SelectItem><SelectItem value="disabled">{T.disabled}</SelectItem></SelectContent></Select></div>
            <div className="space-y-2"><Label>{T.organization}</Label><Input value={memberForm.organizationName} onChange={(event) => setMemberForm((prev) => ({ ...prev, organizationName: event.target.value }))} /></div>
            <div className="space-y-2"><Label>{T.department}</Label><Input value={memberForm.departmentName} onChange={(event) => setMemberForm((prev) => ({ ...prev, departmentName: event.target.value }))} /></div>
            <div className="space-y-2"><Label>{T.team}</Label><Input value={memberForm.teamName} onChange={(event) => setMemberForm((prev) => ({ ...prev, teamName: event.target.value }))} /></div>
            <div className="space-y-2 sm:col-span-2"><Label>{T.space}</Label><Select value={memberForm.spaceId ? String(memberForm.spaceId) : "none"} onValueChange={(value) => setMemberForm((prev) => ({ ...prev, spaceId: value === "none" ? null : Number(value) }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{T.noneSpace}</SelectItem>{spaces.map((space) => <SelectItem key={space.id} value={String(space.id)}>{space.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2 sm:col-span-2"><Label>{T.notes}</Label><Textarea value={memberForm.notes} onChange={(event) => setMemberForm((prev) => ({ ...prev, notes: event.target.value }))} rows={3} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMember(null)}>{T.cancel}</Button>
            <Button onClick={handleSaveMember} disabled={updateMemberMutation.isPending}>{T.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmState} onOpenChange={(open) => !open && setConfirmState(null)}>
        <AlertDialogContent className="border-gray-200 bg-white text-gray-900 shadow-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmState?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const action = confirmState?.onConfirm; setConfirmState(null); action?.(); }}>{T.confirm}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
