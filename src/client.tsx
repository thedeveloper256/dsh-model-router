/**
 * dsh-model-router browser half (v0.6.0).
 *
 * Registers one card into the Plugins settings surface: a live `enabled`
 * switch plus a read-only view of the current routes, and (v0.6.0+) an
 * opt-in Vision routing section with its own live switch. The card binds the
 * `model-router` settings namespace through the client settings scope, exactly
 * like the host-plane cards in `@deepseek-ai/dsh-client-ui-settings-plugins`:
 * the scope's snapshot (`{ status, value, base, user, revision, writable,
 * mode }`) is the single source of truth, and `set`/`unset` writes are
 * revision-fenced and persisted live to `settings.yaml`.
 *
 * Only `react` is imported — every other runtime dependency (`slots`, the
 * settings scope, locale) arrives through cordis services the loader resolves
 * at runtime.
 *
 * @module dsh-model-router/client
 */
import { createElement, type CSSProperties } from "react";

/** Settings namespace this card edits (must match the host's `SETTINGS_NS`). */
const NS = "model-router";

/** Cordis service names this bundle injects (loader-resolved at runtime). */
export const inject = ["slots", "locale", "settingsScope"];

/** English copy. */
const en: Record<string, string> = {
  nav: "Model router",
  title: "Model router",
  description:
    "Role-based model routing: planning runs on deepseek-v4-pro, delegated executor subagents on deepseek-v4-flash.",
  enabled: "Enabled",
  enabledHint:
    "Off stops rewriting requests and unregisters the prompt section and skill; on restores them.",
  on: "On",
  off: "Off",
  reset: "Reset to default",
  overridden: "Overridden",
  readOnly:
    "This deployment stores settings read-only in this browser; use the plugin row in the profile's cordis.patch.yml instead.",
  plannerRoute: "Planner model",
  executorRoute: "Executor model",
  mode: "Mode",
  modeStrict: "strict — the root agent is always the planner",
  modePlan: "plan — the root agent is pro only while plan mode is active",
  visionTitle: "Vision routing",
  visionDesc:
    "Opt-in (default off): when enabled, any request containing an image routes to the vision model, from every role; other requests keep the pro/flash routing.",
  visionSwitch: "Vision",
  visionReset: "Reset vision to default",
  visionRoute: "Vision model",
};

/** Simplified Chinese copy. */
const zh: Record<string, string> = {
  nav: "模型路由",
  title: "模型路由",
  description:
    "按角色分配模型：规划在 deepseek-v4-pro 上运行，委派的执行子代理在 deepseek-v4-flash 上运行。",
  enabled: "启用",
  enabledHint: "关闭后停止改写请求，并注销提示区块与技能；重新打开即恢复。",
  on: "开",
  off: "关",
  reset: "恢复默认",
  overridden: "已覆盖",
  readOnly:
    "当前浏览器中该部署的设置为只读；请改用 profile 的 cordis.patch.yml 中的插件行。",
  plannerRoute: "规划模型",
  executorRoute: "执行模型",
  mode: "模式",
  modeStrict: "strict — 根 agent 始终为规划者",
  modePlan: "plan — 根 agent 仅在计划模式激活时使用 pro",
  visionTitle: "视觉路由",
  visionDesc:
    "可选（默认关闭）：启用后，任何包含图片的请求都会路由到视觉模型，适用于所有角色；其他请求保持 pro/flash 路由。",
  visionSwitch: "视觉",
  visionReset: "恢复视觉默认值",
  visionRoute: "视觉模型",
};

/** The settings scope snapshot this card reads. */
interface ScopeSnapshot {
  status: string;
  value?: ConfigView;
  base?: unknown;
  user?: Partial<ConfigView>;
  revision?: number;
  writable: boolean;
  mode: string;
}

/** The validated `model-router` config as served by the settings transport. */
interface ConfigView {
  enabled: boolean;
  mode: string;
  planner?: { provider?: string; model?: string };
  executor?: { provider?: string; model?: string };
  vision?: { enabled?: boolean; provider?: string; model?: string };
}

/** Minimal cordis browser-context surface this bundle consumes. */
interface ApplyContext {
  locale: {
    bind(ns: string): (key: string) => string;
    register(ns: string, dict: { zh: typeof zh; en: typeof en }): unknown;
  };
  slots: {
    inject(name: string, register: () => Generator<unknown>): unknown;
    register(options: SlotOptions, component: unknown): unknown;
  };
  settingsScope: {
    bind(spec: { namespace: string }): SettingsScope;
  };
  effect(fn: () => void | (() => void), label?: string): unknown;
}

/** One `settings.plugin.item` registration. */
interface SlotOptions {
  name: string;
  key: string;
  locale: string;
  inject(): unknown;
}

/** The bound settings scope for one namespace. */
interface SettingsScope {
  getSnapshot(): ScopeSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<unknown>;
  unset(field: string): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Snapshot-store face the slot machinery turns into a `useXxx` hook prop. */
interface SnapshotStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ScopeSnapshot;
}

/** What the card's slot registration injects. */
interface ModelRouterCardActions {
  hooks: { modelRouterCard: SnapshotStore };
  setEnabled(next: boolean): Promise<void>;
  reset(): Promise<void>;
  setVisionEnabled(next: boolean): Promise<void>;
  resetVision(): Promise<void>;
}

/** Props the card component receives from the slot dispatch. */
interface ModelRouterCardProps {
  t(key: string): string;
  useModelRouterCard<T>(selector: (snapshot: ScopeSnapshot) => T): T;
  setEnabled(next: boolean): Promise<void>;
  reset(): Promise<void>;
  setVisionEnabled(next: boolean): Promise<void>;
  resetVision(): Promise<void>;
}

/**
 * Bridges the `model-router` scope onto the card. Thin by design: the scope
 * itself is the snapshot store, and the card reads it through the slot
 * machinery's `useModelRouterCard` hook. Writes go straight to the scope and
 * any failure settles by re-reading, which re-renders the card.
 */
class ModelRouterCardController {
  scope: SettingsScope;

  constructor(scope: SettingsScope) {
    this.scope = scope;
  }

  get store(): SnapshotStore {
    return {
      subscribe: (listener) => this.scope.subscribe(listener),
      getSnapshot: () => this.scope.getSnapshot(),
    };
  }

  /** Build the face the card's slot registration injects. */
  inject(): ModelRouterCardActions {
    return {
      hooks: { modelRouterCard: this.store },
      setEnabled: async (next) => {
        try {
          await this.scope.set("enabled", next);
        } catch {
          // A failed write settles by re-reading; the snapshot refresh
          // re-renders the card from what the deployment actually accepted.
        }
      },
      reset: async () => {
        try {
          await this.scope.unset("enabled");
        } catch {
          // See setEnabled.
        }
      },
      // Vision toggle merges into the current user-layer vision object so the
      // provider/model base fields survive the write; reset drops the whole
      // vision key from the user layer, restoring the schema defaults.
      setVisionEnabled: async (next) => {
        try {
          const current = this.scope.getSnapshot().value?.vision;
          await this.scope.set("vision", { ...(current ?? {}), enabled: next });
        } catch {
          // See setEnabled.
        }
      },
      resetVision: async () => {
        try {
          await this.scope.unset("vision");
        } catch {
          // See setEnabled.
        }
      },
    };
  }

  /** Stop the scope's mirror subscription when the fiber stops. */
  dispose(): void {
    void this.scope.dispose();
  }
}

/** One read-only route row (label on the left, value on the right). */
function routeRow(label: string, value: string) {
  return createElement("div", { style: styles.routeRow }, [
    createElement("dt", { style: styles.routeLabel }, label),
    createElement("dd", { style: styles.routeValue }, value),
  ]);
}

/** Human-readable `mode` value. */
function modeLabel(t: (key: string) => string, mode: string): string {
  return mode === "plan" ? t("modePlan") : t("modeStrict");
}

/**
 * Render the model router card: the live `enabled` switch, an "overridden"
 * badge and reset button when the user layer overrides `enabled`, a Vision
 * routing section (v0.6.0+) with its own live switch and reset, and read-only
 * route lines. Away from a loopback browser the scope is read-only
 * (`writable` false / `mode` not "host"); the card then shows the unavailable
 * note instead of controls.
 */
function ModelRouterCard(props: ModelRouterCardProps) {
  const { t } = props;
  const state = props.useModelRouterCard((snapshot) => snapshot);
  const unavailable = !state.writable || state.mode !== "host";
  const overridden = state.user?.enabled !== undefined;
  const visionOverridden = state.user?.vision !== undefined;

  return createElement("section", { style: styles.card }, [
    createElement("div", { style: styles.headRow }, [
      createElement("h3", { style: styles.title }, t("title")),
      overridden ? createElement("span", { style: styles.badge }, t("overridden")) : null,
    ]),
    createElement("p", { style: styles.description }, t("description")),
    ...(unavailable
      ? [createElement("p", { style: styles.note }, t("readOnly"))]
      : state.value
        ? [
            createElement("div", { style: styles.switchRow }, [
              createElement("label", { htmlFor: "model-router-enabled", style: styles.label }, t("enabled")),
              createElement("input", {
                id: "model-router-enabled",
                type: "checkbox",
                checked: Boolean(state.value.enabled),
                onChange: (event: { currentTarget: { checked: boolean } }) => {
                  void props.setEnabled(event.currentTarget.checked);
                },
                style: styles.switch,
              }),
              createElement("span", { style: styles.status }, state.value.enabled ? t("on") : t("off")),
            ]),
            createElement("p", { style: styles.hint }, t("enabledHint")),
            overridden
              ? createElement(
                  "button",
                  { type: "button", style: styles.reset, onClick: () => void props.reset() },
                  t("reset"),
                )
              : null,
            createElement("div", { style: styles.vision }, [
              createElement("div", { style: styles.switchRow }, [
                createElement("label", { htmlFor: "model-router-vision", style: styles.label }, t("visionSwitch")),
                createElement("input", {
                  id: "model-router-vision",
                  type: "checkbox",
                  checked: Boolean(state.value.vision?.enabled),
                  onChange: (event: { currentTarget: { checked: boolean } }) => {
                    void props.setVisionEnabled(event.currentTarget.checked);
                  },
                  style: styles.switch,
                }),
                createElement("span", { style: styles.status }, state.value.vision?.enabled ? t("on") : t("off")),
              ]),
              createElement("p", { style: styles.hint }, t("visionDesc")),
              visionOverridden
                ? createElement(
                    "button",
                    { type: "button", style: styles.reset, onClick: () => void props.resetVision() },
                    t("visionReset"),
                  )
                : null,
              createElement("dl", { style: styles.routes }, [
                routeRow(
                  t("visionRoute"),
                  `${state.value.vision?.model ?? "—"} · ${state.value.vision?.provider ?? "—"}`,
                ),
              ]),
            ]),
            createElement("dl", { style: styles.routes }, [
              routeRow(t("plannerRoute"), state.value.planner?.model ?? "—"),
              routeRow(t("executorRoute"), state.value.executor?.model ?? "—"),
              routeRow(t("mode"), modeLabel(t, state.value.mode)),
            ]),
          ]
        : []),
  ]);
}

/** Inline card chrome. Reuses the settings surface's design tokens where available. */
const styles: Record<string, CSSProperties> = {
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px 18px",
    background: "var(--dsw-alias-bg-layer-3)",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: "12px",
    color: "var(--dsw-alias-label-primary)",
    font: "inherit",
  },
  headRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  title: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 600,
    lineHeight: 1.4,
  },
  badge: {
    whiteSpace: "nowrap",
    background: "var(--dsw-alias-bg-module-platform)",
    color: "var(--dsw-alias-label-secondary)",
    borderRadius: "999px",
    padding: "1px 8px",
    fontSize: "11px",
    fontWeight: 500,
    lineHeight: "17px",
  },
  description: {
    margin: 0,
    color: "var(--dsw-alias-label-secondary)",
    fontSize: "13px",
    lineHeight: 1.5,
  },
  switchRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 0",
  },
  label: {
    flex: 1,
    minWidth: 0,
    fontSize: "13px",
    fontWeight: 500,
    lineHeight: 1.5,
  },
  switch: {
    width: "16px",
    height: "16px",
    accentColor: "var(--dsw-alias-brand-primary)",
    cursor: "pointer",
  },
  status: {
    color: "var(--dsw-alias-label-secondary)",
    fontSize: "12px",
    lineHeight: 1.5,
    minWidth: "24px",
  },
  hint: {
    margin: 0,
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "12px",
    lineHeight: 1.5,
  },
  reset: {
    alignSelf: "flex-start",
    font: "inherit",
    color: "var(--dsw-alias-label-secondary)",
    background: "none",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: "8px",
    padding: "4px 10px",
    fontSize: "12px",
    lineHeight: 1.5,
    cursor: "pointer",
  },
  routes: {
    margin: "4px 0 0",
    padding: "10px 0 0",
    borderTop: "1px solid var(--dsw-alias-border-l2)",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  vision: {
    margin: "4px 0 0",
    padding: "12px 0 0",
    borderTop: "1px solid var(--dsw-alias-border-l2)",
  },
  routeRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  routeLabel: {
    minWidth: 0,
    flex: 1,
    margin: 0,
    color: "var(--dsw-alias-label-secondary)",
    fontSize: "12px",
    lineHeight: 1.5,
  },
  routeValue: {
    margin: 0,
    color: "var(--dsw-alias-label-primary)",
    fontSize: "12px",
    lineHeight: 1.5,
    fontVariantNumeric: "tabular-nums",
  },
  note: {
    margin: 0,
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "12px",
    lineHeight: 1.5,
  },
};

/**
 * Mount the card into the Plugins settings surface.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ApplyContext): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(
    () => {
      ctx.locale.register(NS, { zh, en });
    },
    "model-router: card dictionaries",
  );
  const controller = new ModelRouterCardController(ctx.settingsScope.bind({ namespace: NS }));
  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: NS,
        locale: NS,
        inject: () => controller.inject(),
      },
      ModelRouterCard,
    );
  });
  ctx.effect(
    () => () => controller.dispose(),
    "model-router: card controller",
  );
}
