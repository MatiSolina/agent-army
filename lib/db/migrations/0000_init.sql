CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"model" text DEFAULT 'openai/gpt-4o-mini' NOT NULL,
	"systemPrompt" text DEFAULT 'You are a helpful assistant.' NOT NULL,
	"temperature" integer DEFAULT 70 NOT NULL,
	"instructions" text DEFAULT 'You are a helpful assistant. Respond clearly and concisely.' NOT NULL,
	"maxSteps" integer DEFAULT 10 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"toolIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connectionIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subagents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sandbox" jsonb DEFAULT '{"enabled":false}'::jsonb NOT NULL,
	"vercelProjectId" text,
	"deploymentUrl" text,
	"deploymentStatus" text DEFAULT 'none' NOT NULL,
	"lastDeployedAt" timestamp,
	"deploymentError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'kapso' NOT NULL,
	"agentId" text,
	"kapsoApiKey" text,
	"kapsoPhoneNumberId" text,
	"kapsoWebhookSecret" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"token" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"oauthClientInfo" jsonb,
	"oauthServerInfo" jsonb,
	"oauthTokens" jsonb,
	"oauthCodeVerifier" text,
	"oauthState" text,
	"oauthScope" text,
	"oauthError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"channelId" text NOT NULL,
	"agentId" text,
	"conversationId" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"inputSchema" text DEFAULT '' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
