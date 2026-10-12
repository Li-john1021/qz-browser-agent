/** Product UI owns its authentication and provider policy; the feature owns the editable draft. */
export interface SetupIntent { focusSetup?: boolean; provider?: string; focusTarget?: string; startAuth?: boolean }
export interface SetupStatus { state: string; text: string; actionLabel: string; focus?: string }
export interface ProviderPresentation {
  managedAuth?: boolean;
  authenticated?: boolean;
  manualModels?: boolean;
  selectModels?: boolean;
  credentialSource?: string;
  apiKeyPlaceholder?: string;
  apiKeyTitle?: string;
  modelHint?: string;
  authError?: string;
  noModels?: string;
}
export interface SettingsProductHost {
  root: ParentNode;
  signal?: AbortSignal;
  request(type: string, payload: Record<string, unknown>, timeout: number): Promise<Record<string, unknown>>;
  provider(): string;
  ownDraft(): () => boolean;
  changed(): void;
  edited(): void;
  openSuggestions(): void;
  loadModels(reconcile: boolean): Promise<readonly { id: string; label: string }[] | null | undefined>;
  selectAndSave(model: { id: string; label: string }): Promise<boolean>;
}
export interface SettingsProduct {
  readonly welcomeLabel: string;
  readonly connectHint: string;
  setupIntent(focus?: string, connect?: boolean): SetupIntent;
  presentation(provider: string): ProviderPresentation;
  populate(config: Record<string, unknown>): void;
  onboarding(config: Record<string, unknown>): SetupStatus | null;
  sync(): void;
  focus(target: string): boolean;
  connect(saveFirst?: boolean): Promise<boolean>;
  modelError(provider: string, error: unknown): string;
  handleEvent(event: Record<string, unknown>): boolean;
}
