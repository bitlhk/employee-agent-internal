import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Loader2, Plus, RefreshCw, Save, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ModelDraft = {
  modelName: string;
  alias: string;
  apiBase: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  provider: string;
  reasoningLevel: "" | "off" | "low" | "medium" | "high";
  temperature: number;
  isDefault: boolean;
  originIndex?: number;
  contextWindowTokens?: number;
};

type EaModelDraft = {
  modelName: string;
  apiBase: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  provider: string;
  timeoutMs: number;
  disableThinking: boolean;
};

const emptyModel = (): ModelDraft => ({
  modelName: "",
  alias: "",
  apiBase: "",
  apiKey: "",
  apiKeyConfigured: false,
  provider: "OpenAI",
  reasoningLevel: "",
  temperature: 0.95,
  isDefault: true,
});

const modelId = (model: Pick<ModelDraft, "alias" | "modelName">) => model.alias.trim() || model.modelName.trim();

export function ModelSettingsPanel({ enabled = true }: { enabled?: boolean }) {
  const modelSettings = trpc.claw.adminGetModelSettings.useQuery(undefined, { enabled, retry: false });
  const [models, setModels] = useState<ModelDraft[]>([]);
  const [eaModel, setEaModel] = useState<EaModelDraft>({
    modelName: "",
    apiBase: "",
    apiKey: "",
    apiKeyConfigured: false,
    provider: "OpenAI",
    timeoutMs: 8000,
    disableThinking: true,
  });
  const [initializedAt, setInitializedAt] = useState(0);

  useEffect(() => {
    if (!modelSettings.data || modelSettings.dataUpdatedAt === initializedAt) return;
    setModels(modelSettings.data.models.map((model) => ({
      modelName: model.modelName,
      alias: model.alias,
      apiBase: model.apiBase,
      apiKey: "",
      apiKeyConfigured: model.apiKeyConfigured,
      provider: model.provider,
      reasoningLevel: model.reasoningLevel as ModelDraft["reasoningLevel"],
      temperature: model.temperature,
      isDefault: model.isDefault,
      originIndex: model.originIndex,
      contextWindowTokens: model.contextWindowTokens,
    })));
    setEaModel({
      modelName: modelSettings.data.eaModel.modelName,
      apiBase: modelSettings.data.eaModel.apiBase,
      apiKey: "",
      apiKeyConfigured: modelSettings.data.eaModel.apiKeyConfigured,
      provider: modelSettings.data.eaModel.provider,
      timeoutMs: modelSettings.data.eaModel.timeoutMs,
      disableThinking: modelSettings.data.eaModel.disableThinking,
    });
    setInitializedAt(modelSettings.dataUpdatedAt);
  }, [initializedAt, modelSettings.data, modelSettings.dataUpdatedAt]);

  const validateMutation = trpc.claw.adminValidateAgentModel.useMutation({
    onSuccess: (result) => toast.success(`模型连接正常（${result.elapsedMs} ms）`),
    onError: (error) => toast.error(error.message || "模型连接测试失败"),
  });
  const saveMutation = trpc.claw.adminSaveModelSettings.useMutation({
    onSuccess: async () => {
      toast.success("模型配置已保存并热加载");
      await modelSettings.refetch();
    },
    onError: (error) => toast.error(error.message || "模型配置保存失败"),
  });
  const validateEaMutation = trpc.claw.adminValidateEaAssistantModel.useMutation({
    onSuccess: (result) => toast.success(`EA 模型连接正常（${result.elapsedMs} ms）`),
    onError: (error) => toast.error(error.message || "EA 模型连接测试失败"),
  });
  const saveEaMutation = trpc.claw.adminSaveEaAssistantModel.useMutation({
    onSuccess: async () => {
      toast.success("EA 平台模型已保存");
      await modelSettings.refetch();
    },
    onError: (error) => toast.error(error.message || "EA 模型配置保存失败"),
  });

  const providers = modelSettings.data?.providers || ["OpenAI"];
  const duplicateIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of models) {
      const id = modelId(model);
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
  }, [models]);

  const updateModel = <K extends keyof ModelDraft>(index: number, key: K, value: ModelDraft[K]) => {
    setModels((current) => current.map((model, itemIndex) => itemIndex === index ? { ...model, [key]: value } : model));
  };

  const setPrimary = (index: number) => {
    setModels((current) => {
      const next = current.map((model) => ({ ...model }));
      const [selected] = next.splice(index, 1);
      selected.isDefault = true;
      for (const model of next) {
        if (model.modelName === selected.modelName) model.isDefault = false;
      }
      next.unshift(selected);
      return next;
    });
  };

  const setGroupDefault = (index: number, checked: boolean) => {
    setModels((current) => {
      const next = current.map((model) => ({ ...model }));
      const target = next[index];
      const sameName = next.map((model, itemIndex) => ({ model, itemIndex }))
        .filter(({ model }) => model.modelName === target.modelName);
      if (sameName.length <= 1) return next;
      if (checked) {
        for (const { itemIndex } of sameName) next[itemIndex].isDefault = itemIndex === index;
      } else {
        target.isDefault = false;
        const fallback = sameName.find(({ itemIndex }) => itemIndex !== index);
        if (fallback) next[fallback.itemIndex].isDefault = true;
      }
      const primaryName = next[0]?.modelName;
      if (primaryName === target.modelName) {
        const defaultIndex = next.findIndex((model) => model.modelName === primaryName && model.isDefault);
        if (defaultIndex > 0) {
          const [primary] = next.splice(defaultIndex, 1);
          next.unshift(primary);
        }
      }
      return next;
    });
  };

  const removeModel = (index: number) => {
    if (models.length <= 1) {
      toast.error("至少保留一个 Agent 模型");
      return;
    }
    setModels((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const mutationInput = (model: ModelDraft) => ({
    modelName: model.modelName.trim(),
    alias: model.alias.trim(),
    apiBase: model.apiBase.trim(),
    ...(model.apiKey ? { apiKey: model.apiKey } : {}),
    provider: model.provider as any,
    reasoningLevel: model.reasoningLevel,
    temperature: Number(model.temperature),
    isDefault: model.isDefault,
    ...(model.originIndex !== undefined ? { originIndex: model.originIndex } : {}),
  });

  const validateForm = () => {
    if (models.length === 0) return "至少保留一个 Agent 模型";
    for (const [index, model] of models.entries()) {
      if (!model.modelName.trim()) return `第 ${index + 1} 个模型缺少 model_name`;
      if (!model.apiBase.trim()) return `${modelId(model)} 缺少 api_base`;
      if (!model.provider) return `${modelId(model)} 缺少 model_provider`;
      if (!model.apiKey && !model.apiKeyConfigured) return `${modelId(model)} 缺少 api_key`;
      if (duplicateIds.has(modelId(model))) return `模型名称或别名重复：${modelId(model)}`;
    }
    return "";
  };

  const save = () => {
    const error = validateForm();
    if (error) {
      toast.error(error);
      return;
    }
    saveMutation.mutate({ models: models.map(mutationInput) });
  };

  const eaMutationInput = () => ({
    modelName: eaModel.modelName.trim(),
    apiBase: eaModel.apiBase.trim(),
    ...(eaModel.apiKey ? { apiKey: eaModel.apiKey } : {}),
    provider: eaModel.provider as any,
    timeoutMs: Number(eaModel.timeoutMs),
    disableThinking: eaModel.disableThinking,
  });

  const validateEaForm = () => {
    if (!eaModel.modelName.trim()) return "EA 平台模型缺少 model_name";
    if (!eaModel.apiBase.trim()) return "EA 平台模型缺少 api_base";
    if (!eaModel.apiKey && !eaModel.apiKeyConfigured) return "EA 平台模型缺少 api_key";
    return "";
  };

  const runEaAction = (action: "validate" | "save") => {
    const error = validateEaForm();
    if (error) {
      toast.error(error);
      return;
    }
    if (action === "validate") validateEaMutation.mutate(eaMutationInput());
    else saveEaMutation.mutate(eaMutationInput());
  };

  if (!enabled || modelSettings.isLoading) {
    return <Card className="p-6"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取 JiuwenSwarm 模型配置</div></Card>;
  }

  if (modelSettings.error) {
    return (
      <Card className="p-6 space-y-3">
        <div className="text-sm font-medium text-red-700">JiuwenSwarm 模型配置读取失败</div>
        <div className="text-xs text-muted-foreground">{modelSettings.error.message}</div>
        <Button variant="outline" size="sm" onClick={() => modelSettings.refetch()}><RefreshCw className="h-4 w-4" />重试</Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-6 space-y-5 border-border/50 bg-white/80">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Agent 模型</h3>
            <p className="mt-1 text-xs text-muted-foreground">模型由 JiuwenSwarm 保存并热加载。列表首项是主对话默认模型。</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setModels((current) => [...current, emptyModel()])}>
            <Plus className="h-4 w-4" />添加模型
          </Button>
        </div>

        <div className="space-y-3">
          {models.map((model, index) => {
            const sameNameCount = models.filter((item) => item.modelName === model.modelName).length;
            const validationPending = validateMutation.isPending && validateMutation.variables?.originIndex === model.originIndex;
            return (
              <div key={`${model.originIndex ?? "new"}-${index}`} className="overflow-hidden rounded-md border border-gray-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50/70 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">{model.alias || model.modelName || "新模型"}</span>
                    {index === 0 && <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">主对话默认</span>}
                    {model.isDefault && <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">组内默认</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    {index !== 0 && <Button variant="ghost" size="sm" className="h-8" onClick={() => setPrimary(index)}><Star className="h-3.5 w-3.5" />设为主模型</Button>}
                    <Button variant="ghost" size="sm" className="h-8" disabled={validateMutation.isPending} onClick={() => validateMutation.mutate(mutationInput(model))}>
                      {validationPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}测试
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600" title="删除模型" disabled={models.length <= 1} onClick={() => removeModel(index)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>

                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <Field label="model_name" required><Input value={model.modelName} onChange={(event) => updateModel(index, "modelName", event.target.value)} /></Field>
                  <Field label="alias"><Input value={model.alias} onChange={(event) => updateModel(index, "alias", event.target.value)} placeholder="可选，建议为 EA 选择模型时使用" /></Field>
                  <Field label="api_base" required><Input value={model.apiBase} onChange={(event) => updateModel(index, "apiBase", event.target.value)} placeholder="https://api.example.com/v1" /></Field>
                  <Field label="api_key" required>
                    <Input type="password" autoComplete="new-password" value={model.apiKey} onChange={(event) => updateModel(index, "apiKey", event.target.value)} placeholder={model.apiKeyConfigured ? "已配置，留空保持不变" : "请输入 API Key"} />
                  </Field>
                  <Field label="model_provider" required>
                    <Select value={model.provider} onValueChange={(value) => updateModel(index, "provider", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider} value={provider}>{provider}</SelectItem>)}</SelectContent></Select>
                  </Field>
                  <Field label="reasoning_level">
                    <Select value={model.reasoningLevel || "default"} onValueChange={(value) => updateModel(index, "reasoningLevel", value === "default" ? "" : value as ModelDraft["reasoningLevel"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">使用默认值</SelectItem><SelectItem value="off">off</SelectItem><SelectItem value="low">low</SelectItem><SelectItem value="medium">medium</SelectItem><SelectItem value="high">high</SelectItem></SelectContent></Select>
                  </Field>
                  <Field label="temperature"><Input type="number" min="0" max="2" step="0.05" value={model.temperature} onChange={(event) => updateModel(index, "temperature", Number(event.target.value))} /></Field>
                  <div className="flex items-end pb-2">
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={model.isDefault} disabled={sameNameCount <= 1} onChange={(event) => setGroupDefault(index, event.target.checked)} />
                      同模型名组内默认
                      {sameNameCount <= 1 && <span className="text-xs text-muted-foreground">仅一个，自动默认</span>}
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end">
          <Button onClick={save} disabled={saveMutation.isPending || models.length === 0}>
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存并应用 Agent 模型
          </Button>
        </div>
      </Card>

      <Card className="p-6 space-y-5 border-border/50 bg-white/80">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">EA 平台模型</h3>
          <p className="mt-1 text-xs text-muted-foreground">用于会话标题等轻量任务，独立于 Agent 主对话模型。</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="model_name" required>
            <Input value={eaModel.modelName} onChange={(event) => setEaModel((current) => ({ ...current, modelName: event.target.value }))} placeholder="openpangu-2.0-flash" />
          </Field>
          <Field label="model_provider" required>
            <Select value={eaModel.provider} onValueChange={(provider) => setEaModel((current) => ({ ...current, provider }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{providers.map((provider) => <SelectItem key={provider} value={provider}>{provider}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="api_base" required>
            <Input value={eaModel.apiBase} onChange={(event) => setEaModel((current) => ({ ...current, apiBase: event.target.value }))} placeholder="https://api.example.com/v1" />
          </Field>
          <Field label="api_key" required>
            <Input type="password" autoComplete="new-password" value={eaModel.apiKey} onChange={(event) => setEaModel((current) => ({ ...current, apiKey: event.target.value }))} placeholder={eaModel.apiKeyConfigured ? "已配置，留空保持不变" : "请输入 API Key"} />
          </Field>
          <Field label="timeout_ms">
            <Input type="number" min="1000" max="120000" step="1000" value={eaModel.timeoutMs} onChange={(event) => setEaModel((current) => ({ ...current, timeoutMs: Number(event.target.value) }))} />
          </Field>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={eaModel.disableThinking} onChange={(event) => setEaModel((current) => ({ ...current, disableThinking: event.target.checked }))} />
              关闭模型思考模式
            </label>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => runEaAction("validate")} disabled={validateEaMutation.isPending || saveEaMutation.isPending}>
            {validateEaMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            测试 EA 模型
          </Button>
          <Button onClick={() => runEaAction("save")} disabled={saveEaMutation.isPending || validateEaMutation.isPending}>
            {saveEaMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存 EA 模型
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}{required && <span className="ml-0.5 text-red-600">*</span>}</Label>{children}</div>;
}
