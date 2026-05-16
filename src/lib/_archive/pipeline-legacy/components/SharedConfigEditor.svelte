<script lang="ts">
	import { onMount } from 'svelte';

	interface ConfigColumn {
		name: string;
		type: 'text' | 'select' | 'number';
		label: string;
		placeholder?: string;
		options?: string[];
		required?: boolean;
	}

	interface ConfigFile {
		name: string;
		file: string;
		description?: string;
		columns?: ConfigColumn[];
	}

	interface Props {
		pipelineName: string;
		configFile: ConfigFile;
	}

	let { pipelineName, configFile }: Props = $props();

	let rows = $state<Record<string, unknown>[]>([]);
	let loading = $state(true);
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let saving = $state(false);

	const columns: ConfigColumn[] = configFile.columns || [];

	onMount(async () => {
		try {
			const res = await fetch(`/api/config-file?pipeline=${encodeURIComponent(pipelineName)}&file=${encodeURIComponent(configFile.file)}`);
			if (res.ok) {
				const data = await res.json();
				rows = data.rows || [];
			}
		} catch { /* empty state */ }
		loading = false;
	});

	function scheduleSave() {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => save(), 500);
	}

	async function save() {
		saving = true;
		try {
			await fetch('/api/config-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pipeline: pipelineName, file: configFile.file, rows }),
			});
		} catch { /* silent */ }
		saving = false;
	}

	function addRow() {
		const newRow: Record<string, unknown> = {};
		for (const col of columns) {
			newRow[col.name] = col.type === 'number' ? 0 : '';
		}
		rows = [...rows, newRow];
		scheduleSave();
	}

	function deleteRow(index: number) {
		rows = rows.filter((_, i) => i !== index);
		scheduleSave();
	}

	function updateCell(rowIndex: number, colName: string, value: unknown) {
		rows[rowIndex] = { ...rows[rowIndex], [colName]: value };
		rows = [...rows];
		scheduleSave();
	}
</script>

<div class="bg-hub-surface border border-hub-border rounded-lg overflow-hidden">
	<!-- Header -->
	<div class="flex items-center justify-between px-4 py-3 border-b border-hub-border/30">
		<div class="min-w-0">
			<h3 class="text-xs font-medium text-hub-text">{configFile.name}</h3>
			{#if configFile.description}
				<p class="text-[10px] text-hub-dim mt-0.5">{configFile.description}</p>
			{/if}
		</div>
		<div class="flex items-center gap-2 flex-shrink-0">
			{#if saving}
				<span class="text-[9px] text-hub-info">Saving...</span>
			{/if}
			<span class="text-[9px] text-hub-dim font-mono">{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
		</div>
	</div>

	{#if loading}
		<div class="px-4 py-6 text-center text-[10px] text-hub-dim">Loading...</div>
	{:else if columns.length === 0}
		<div class="px-4 py-6 text-center text-[10px] text-hub-dim">No column schema defined for this config file.</div>
	{:else if rows.length === 0}
		<div class="px-4 py-6 text-center">
			<p class="text-[11px] text-hub-dim mb-3">No entries yet.</p>
			<button onclick={addRow}
				class="px-3 py-1.5 rounded text-[11px] font-medium text-hub-info border border-hub-info/30 hover:bg-hub-info/10 transition-colors cursor-pointer">
				Add Row
			</button>
		</div>
	{:else}
		<!-- Table -->
		<div class="overflow-x-auto">
			<table class="w-full text-[11px]">
				<thead>
					<tr class="border-b border-hub-border/30">
						{#each columns as col}
							<th class="px-3 py-2 text-left text-[10px] font-medium text-hub-dim uppercase tracking-wider whitespace-nowrap">
								{col.label}
								{#if col.required}<span class="text-hub-danger">*</span>{/if}
							</th>
						{/each}
						<th class="w-8"></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row, rowIndex}
						<tr class="border-b border-hub-border/10 hover:bg-hub-bg/30">
							{#each columns as col}
								<td class="px-2 py-1.5">
									{#if col.type === 'select' && col.options}
										<select
											value={String(row[col.name] ?? '')}
											onchange={(e) => updateCell(rowIndex, col.name, e.currentTarget.value)}
											class="w-full bg-hub-bg border border-hub-border/50 rounded px-2 py-1 text-[11px] text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-info/50 cursor-pointer"
										>
											<option value="">--</option>
											{#each col.options as opt}
												<option value={opt}>{opt}</option>
											{/each}
										</select>
									{:else if col.type === 'number'}
										<input
											type="number"
											value={Number(row[col.name] ?? 0)}
											oninput={(e) => updateCell(rowIndex, col.name, Number(e.currentTarget.value))}
											placeholder={col.placeholder || ''}
											class="w-full bg-hub-bg border border-hub-border/50 rounded px-2 py-1 text-[11px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
										/>
									{:else}
										<input
											type="text"
											value={String(row[col.name] ?? '')}
											oninput={(e) => updateCell(rowIndex, col.name, e.currentTarget.value)}
											placeholder={col.placeholder || ''}
											class="w-full bg-hub-bg border border-hub-border/50 rounded px-2 py-1 text-[11px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
										/>
									{/if}
								</td>
							{/each}
							<td class="px-2 py-1.5 text-center">
								<button onclick={() => deleteRow(rowIndex)}
									class="text-hub-dim hover:text-hub-danger transition-colors cursor-pointer text-xs"
									title="Delete row"
								>&times;</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Add Row -->
		<div class="px-4 py-2 border-t border-hub-border/30">
			<button onclick={addRow}
				class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer">
				+ Add Row
			</button>
		</div>
	{/if}
</div>
