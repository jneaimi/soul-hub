<!--
  ConfigWidget — renders a single config field based on its ConfigFieldType.
  Pure presentation, Svelte 5 ($props/$state).
-->
<script lang="ts">
	import type { ConfigFieldType } from '$lib/pipeline/block';

	interface Props {
		name: string;
		type: ConfigFieldType;
		label?: string;
		description?: string;
		value: unknown;
		options?: string[];
		min?: number;
		max?: number;
		required?: boolean;
		onchange: (name: string, value: unknown) => void;
	}

	let {
		name,
		type,
		label,
		description,
		value,
		options = [],
		min,
		max,
		required = false,
		onchange,
	}: Props = $props();

	// Local toggle state derived from value prop
	let checked = $derived(value === true || value === 'true');

	// Multiselect: keep selected items as an array
	let selectedItems = $derived<string[]>(
		Array.isArray(value) ? value.map(String) : value ? [String(value)] : []
	);

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
		if (type === 'number') {
			const num = target.value === '' ? '' : Number(target.value);
			onchange(name, num);
		} else {
			onchange(name, target.value);
		}
	}

	function handleToggle() {
		onchange(name, !checked);
	}

	function handleMultiselect(option: string, isChecked: boolean) {
		const next = isChecked
			? [...selectedItems, option]
			: selectedItems.filter(s => s !== option);
		onchange(name, next);
	}
</script>

<div class="flex flex-col gap-1">
	{#if label}
		<label for="cfg-{name}" class="text-[11px] font-medium text-hub-muted flex items-center gap-1">
			{label}
			{#if required}
				<span class="text-hub-danger text-[9px]">*</span>
			{/if}
		</label>
	{/if}

	<!-- text -->
	{#if type === 'text'}
		<input
			id="cfg-{name}"
			type="text"
			value={typeof value === 'string' ? value : value != null ? String(value) : ''}
			oninput={handleInput}
			placeholder={label || name}
			class="w-full bg-hub-bg border border-hub-border/50 rounded-md px-2.5 py-1.5 text-xs text-hub-text font-mono
				focus:outline-none focus:ring-1 focus:ring-hub-info/50 placeholder:text-hub-dim/50"
		/>

	<!-- number -->
	{:else if type === 'number'}
		<div class="flex items-center gap-2">
			<input
				id="cfg-{name}"
				type="number"
				value={value != null ? Number(value) : ''}
				min={min}
				max={max}
				oninput={handleInput}
				class="w-24 bg-hub-bg border border-hub-border/50 rounded-md px-2.5 py-1.5 text-xs text-hub-text font-mono text-center
					focus:outline-none focus:ring-1 focus:ring-hub-info/50
					[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
			/>
			{#if min != null || max != null}
				<span class="text-[9px] text-hub-dim font-mono">
					{#if min != null && max != null}{min}–{max}{:else if min != null}min {min}{:else}max {max}{/if}
				</span>
			{/if}
		</div>

	<!-- select -->
	{:else if type === 'select'}
		<select
			id="cfg-{name}"
			value={typeof value === 'string' ? value : value != null ? String(value) : ''}
			onchange={handleInput}
			class="w-full bg-hub-bg border border-hub-border/50 rounded-md px-2.5 py-1.5 text-xs text-hub-text font-mono
				focus:outline-none focus:ring-1 focus:ring-hub-info/50 cursor-pointer"
		>
			{#if !required}
				<option value="">— select —</option>
			{/if}
			{#each options ?? [] as opt}
				<option value={opt}>{opt}</option>
			{/each}
		</select>

	<!-- multiselect (checkbox group) -->
	{:else if type === 'multiselect'}
		<div class="flex flex-wrap gap-x-3 gap-y-1.5 py-0.5">
			{#each options ?? [] as opt}
				{@const isSelected = selectedItems.includes(opt)}
				<label class="flex items-center gap-1.5 cursor-pointer group">
					<input
						type="checkbox"
						checked={isSelected}
						onchange={() => handleMultiselect(opt, !isSelected)}
						class="w-3 h-3 rounded border-hub-border bg-hub-bg accent-hub-cta cursor-pointer"
					/>
					<span class="text-[11px] {isSelected ? 'text-hub-text' : 'text-hub-dim'} group-hover:text-hub-muted transition-colors">
						{opt}
					</span>
				</label>
			{/each}
		</div>

	<!-- toggle (switch) -->
	{:else if type === 'toggle'}
		<button
			id="cfg-{name}"
			type="button"
			onclick={handleToggle}
			class="relative w-9 h-5 rounded-full transition-colors cursor-pointer
				{checked ? 'bg-hub-cta' : 'bg-hub-border'}"
			role="switch"
			aria-checked={checked}
			aria-label={label || name}
		>
			<span
				class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform
					{checked ? 'translate-x-4' : 'translate-x-0'}"
			></span>
		</button>

	<!-- file (path input) -->
	{:else if type === 'file'}
		<div class="flex items-center gap-1.5">
			<input
				id="cfg-{name}"
				type="text"
				value={typeof value === 'string' ? value : value != null ? String(value) : ''}
				oninput={handleInput}
				placeholder="path/to/file"
				class="flex-1 bg-hub-bg border border-hub-border/50 rounded-md px-2.5 py-1.5 text-xs text-hub-text font-mono
					focus:outline-none focus:ring-1 focus:ring-hub-info/50 placeholder:text-hub-dim/50"
			/>
			<span class="text-[9px] text-hub-dim px-1.5 py-1 rounded bg-hub-card border border-hub-border/30">file</span>
		</div>

	<!-- textarea -->
	{:else if type === 'textarea'}
		<textarea
			id="cfg-{name}"
			value={typeof value === 'string' ? value : value != null ? String(value) : ''}
			oninput={handleInput}
			rows={3}
			placeholder={label || name}
			class="w-full bg-hub-bg border border-hub-border/50 rounded-md px-2.5 py-1.5 text-xs text-hub-text font-mono leading-relaxed resize-y
				focus:outline-none focus:ring-1 focus:ring-hub-info/50 placeholder:text-hub-dim/50"
		></textarea>
	{/if}

	{#if description}
		<p class="text-[9px] text-hub-dim leading-snug">{description}</p>
	{/if}
</div>
