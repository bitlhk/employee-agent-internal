import { Cpu, Loader2, Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  presentModel,
  type ModelPresentation,
  type RuntimeModelOption,
} from "@/lib/modelPresentation";

type ModelPickerProps = {
  models: RuntimeModelOption[];
  value: string;
  disabled?: boolean;
  pending?: boolean;
  onValueChange: (modelId: string) => void;
};

function ProviderIcon({ model }: { model: ModelPresentation }) {
  return (
    <span className="model-provider-logo" aria-hidden="true">
      {model.brand === "auto" ? (
        <Sparkles size={15} strokeWidth={1.8} />
      ) : model.iconSrc ? (
        <img src={model.iconSrc} alt="" />
      ) : (
        <Cpu size={15} strokeWidth={1.8} />
      )}
    </span>
  );
}

export function ModelPicker({
  models,
  value,
  disabled,
  pending,
  onValueChange,
}: ModelPickerProps) {
  const selected = value
    ? presentModel(models.find(model => model.id === value) || { id: value })
    : { ...presentModel({ id: "default" }), displayName: "同步模型..." };
  const options = models.map(presentModel);

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        size="sm"
        aria-label="选择模型"
        className="lingxia-composer-model-select focus:ring-0 focus:ring-offset-0"
        disabled={disabled || models.length === 0}
      >
        <ProviderIcon model={selected} />
        <span className="lingxia-composer-model-select__name">
          {selected.displayName || "同步模型..."}
        </span>
        {pending ? (
          <Loader2
            className="lingxia-composer-model-select__loading animate-spin"
            aria-hidden="true"
          />
        ) : null}
      </SelectTrigger>
      <SelectContent
        className="lingxia-model-menu"
        position="popper"
        align="start"
        sideOffset={5}
      >
        {options.map(model => (
          <SelectItem
            key={model.id}
            value={model.id}
            disabled={!model.available}
            className="lingxia-model-item"
          >
            <ProviderIcon model={model} />
            <span className="lingxia-model-item__name">
              {model.displayName}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
