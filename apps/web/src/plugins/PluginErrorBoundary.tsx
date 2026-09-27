import { Component, type ReactNode } from "react";

/** Keeps one plugin's render error inside its own slot. */
export class PluginErrorBoundary extends Component<
  { pluginId: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[plugin:${this.props.pluginId}] render failed:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="px-3 py-4 text-xs text-muted-foreground"
          data-testid="plugin-slot__error"
          data-plugin-id={this.props.pluginId}
        >
          The {this.props.pluginId} plugin failed to render: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
