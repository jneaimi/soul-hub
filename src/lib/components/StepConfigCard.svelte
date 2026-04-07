<!--
  StepConfigCard — expandable step card showing block info, config widgets,
  and env status. Pure presentation, Svelte 5.
-->
<script lang="ts">
	import ConfigWidget from './ConfigWidget.svelte';
	import type { ConfigFieldType } from '$lib/pipeline/block';

	interface ConfigField {
		name: string;
		type: ConfigFieldType;
		label?: string;
		description?: string;
		default?: unknown;
		min?: number;
		max?: number;
		options?: string[];
		required?: boolean;
	}

	interface BlockManifest {
		name: string;
		type: string;
		runtime?: string;
		description: string;
		version?: string;
		config?: ConfigField[];
		env?: { name: string; description?: string; required?: boolean }[];
	}

	interface StepDef {
		id: string;
		type?: string;
		block?: string;
		config?: Record<string, unknown>;
		depends_on?: string[];
	}

	interface EnvEntry {
		name: string;
		set: boolean;
		description?: string;
	}

	interface Props {
		step: StepDef;
		block?: BlockManifest;
		configValues: Record<string, unknown>;
		envStatus: EnvEntry[];
		expanded: boolean;
		ontoggle: (stepId: string) => void;
		onconfigchange: (stepId: string, name: string, value: unknown) => void;
	}

	let {
		step,
		block,
		configValues,
		envStatus,
		expanded,
		ontoggle,
		onconfigchange,
	}: Props = $props();

	// Derived: merge block defaults with step overrides
	let mergedConfig = $derived.by(() => {
		const merged: Record<string, unknown> = {};
		if (block?.config) {
			for (const field of block.config) {
				merged[field.name] = field.default ?? '';
			}
		}
		// Step-level config overrides defaults
		if (step.config) {
			for (const [k, v] of Object.entries(step.config)) {
				merged[k] = v;
			}
		}
		// Live edits override everything
		for (const [k, v] of Object.entries(configValues)) {
			merged[k] = v;
		}
		return merged;
	});

	let hasConfig = $derived((block?.config?.length ?? 0) > 0);
	let missingEnv = $derived(envStatus.filter(e => !e.set));
	let allEnvSet = $derived(missingEnv.length === 0);

	// Block type color map
	const typeColors: Record<string, string> = {
		script: 'bg-hub-info/10 text-hub-info',
		agent: 'bg-hub-purple/10 text-hub-purple',
		skill: 'bg-hub-warning/10 text-hub-warning',
		mcp: 'bg-hub-cta/10 text-hub-cta',
		pipeline: 'bg-hub-danger/10 text-hub-danger',
	};

	function handleConfigChange(name: string, value: unknown) {
		onconfigchange(step.id, name, value);
	}
</script>

<div class="rounded-lg border overflow-hidden transition-colors border-hub-border/50 bg-hub-surface">
	<!-- Header (clickable to expand) -->
	<button
		onclick={() => ontoggle(step.id)}
		class="w-full flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-hub-bg/30 transition-colors"
	>
		<!-- Step ID + metadata -->
		<div class="flex-1 text-left">
			<div class="flex items-center gap-2 flex-wrap">
				<span class="text-sm font-mono font-medium text-hub-text">{step.id}</span>

				{#if block}
					<span class="px-1.5 py-0.5 rounded text-[9px] font-medium {typeColors[block.type] || 'bg-hub-dim/15 text-hub-dim'}">
						{block.type}
					</span>
					<span class="px-1.5 py-0.5 rounded text-[9px] font-medium bg-hub-cta/10 text-hub-cta">
						{block.name}{#if block.version} v{block.version}{/if}
					</span>
				{:else if step.block}
					<span class="px-1.5 py-0.5 rounded text-[9px] font-medium bg-hub-dim/15 text-hub-dim italic">
						{step.block} (not installed)
					</span>
				{/if}

				<!-- Env status dots -->
				{#if envStatus.length > 0}
					<span class="flex items-center gap-0.5 ml-1" title={allEnvSet ? 'All env vars set' : `Missing: ${missingEnv.map(e => e.name).join(', ')}`}>
						{#each envStatus as ev}
							<span class="w-1.5 h-1.5 rounded-full {ev.set ? 'bg-hub-cta' : 'bg-hub-danger'}" title="{ev.name}: {ev.set ? 'set' : 'missing'}"></span>
						{/each}
					</span>
				{/if}
			</div>

			<p class="text-[11px] text-hub-dim mt-0.5">
				{#if block}
					{block.description}
				{:else}
					{step.block || step.type || ''}
				{/if}
				{#if step.depends_on?.length}
					<span class="text-hub-dim/50"> after {step.depends_on.join(', ')}</span>
				{/if}
			</p>
		</div>

		<!-- Chevron -->
		<svg class="w-3.5 h-3.5 text-hub-dim transition-transform flex-shrink-0 {expanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
	</button>

	<!-- Expanded: config widgets + env + actions -->
	{#if expanded}
		<div class="border-t border-hub-border/30 px-4 py-3 space-y-4 bg-hub-bg/20">

			<!-- Config fields grid -->
			{#if hasConfig && block?.config}
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					{#each block.config as field (field.name)}
						<ConfigWidget
							name={field.name}
							type={field.type}
							label={field.label || field.name}
							description={field.description}
							value={mergedConfig[field.name]}
							options={field.options}
							min={field.min}
							max={field.max}
							required={field.required}
							onchange={handleConfigChange}
						/>
					{/each}
				</div>
			{:else if !block}
				<p class="text-[11px] text-hub-dim italic">No block manifest found — install the block to configure.</p>
			{:else}
				<p class="text-[11px] text-hub-dim italic">No configurable fields.</p>
			{/if}

			<!-- Env vars status -->
			{#if envStatus.length > 0}
				<div class="pt-2 border-t border-hub-border/20">
					<p class="text-[10px] font-medium text-hub-muted mb-1.5">Environment</p>
					<div class="flex flex-wrap gap-2">
						{#each envStatus as ev}
							<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono
								{ev.set ? 'bg-hub-cta/10 text-hub-cta' : 'bg-hub-danger/10 text-hub-danger'}">
								<span class="w-1.5 h-1.5 rounded-full {ev.set ? 'bg-hub-cta' : 'bg-hub-danger'}"></span>
								{ev.name}
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Footer: block info -->
			{#if block}
				<div class="pt-2 border-t border-hub-border/20">
					<span class="text-[10px] text-hub-dim">
						{block.name}{#if block.version} v{block.version}{/if}
						{#if block.runtime}
							<span class="text-hub-dim/60"> ({block.runtime})</span>
						{/if}
					</span>
				</div>
			{/if}
		</div>
	{/if}
</div>
