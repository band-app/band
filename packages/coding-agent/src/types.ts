import type { AgentEvent } from "./events.js";

export interface CodingAgentFeatures {
	costTracking: boolean;
}

export interface CodingAgent {
	readonly name: string;
	readonly supportedFeatures: CodingAgentFeatures;
	runSession(prompt: string, sessionId?: string): AsyncGenerator<AgentEvent>;
}
