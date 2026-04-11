<script lang="ts">
	import { goto } from '$app/navigation';

	let projectName = $state('');
	let description = $state('');
	let creating = $state(false);
	let error = $state('');

	const nameValid = $derived(/^[a-z][a-z0-9-]*$/.test(projectName) && projectName.length >= 2);
	const canCreate = $derived(nameValid && description.trim().length > 0);

	async function createProject() {
		if (creating || !canCreate) return;
		creating = true;
		error = '';

		try {
			const res = await fetch('/api/projects/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: projectName.trim(),
					description: description.trim(),
					type: 'web-app', // placeholder — AI will determine the real type during setup
				}),
			});

			const data = await res.json();

			if (!res.ok) {
				error = data.error || data.errors?.join(', ') || 'Failed to create project';
				return;
			}

			goto(`/project/${encodeURIComponent(projectName.trim())}?setup=true`);
		} catch {
			error = 'Network error';
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head>
	<title>New Project | Soul Hub</title>
</svelte:head>

<div class="min-h-screen bg-hub-bg text-hub-text">
	<div class="max-w-lg mx-auto px-6 py-10">
		<div class="flex items-center gap-3 mb-8">
			<a href="/" class="text-hub-muted hover:text-hub-text text-sm transition-colors cursor-pointer">&lt; Back</a>
			<h1 class="text-xl font-bold">New Project</h1>
		</div>

		<div class="space-y-6">
			<div>
				<label for="project-name" class="block text-sm font-medium mb-2">Project name</label>
				<input
					id="project-name"
					type="text"
					bind:value={projectName}
					placeholder="my-awesome-project"
					class="w-full bg-hub-surface border border-hub-border rounded-lg px-4 py-2.5 text-hub-text font-mono focus:outline-none focus:ring-2 focus:ring-hub-cta/30 focus:border-hub-cta/50"
				/>
				{#if projectName && !nameValid}
					<p class="text-xs text-hub-danger mt-1">Lowercase letters, numbers, hyphens only. Min 2 characters.</p>
				{:else}
					<p class="text-xs text-hub-dim mt-1">Creates ~/dev/{projectName || '...'}/</p>
				{/if}
			</div>

			<div>
				<label for="description" class="block text-sm font-medium mb-2">What are you building?</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder="Describe your project — what it does, who it's for, key features. The more detail you give, the better the AI can configure your setup.

Example: A Python script that uses the Gemini API to generate images and video clips from text prompts, with a CLI interface for batch processing."
					rows="5"
					class="w-full bg-hub-surface border border-hub-border rounded-lg px-4 py-3 text-hub-text text-sm leading-relaxed resize-y min-h-[120px] focus:outline-none focus:ring-2 focus:ring-hub-cta/30 focus:border-hub-cta/50"
				></textarea>
				<p class="text-xs text-hub-dim mt-1">This description helps the AI suggest the right stack, tooling, and pipelines</p>
			</div>

			<div class="bg-hub-surface border border-hub-border/50 rounded-lg p-4">
				<div class="flex items-start gap-3">
					<svg class="w-5 h-5 text-hub-info flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
					</svg>
					<p class="text-xs text-hub-muted">
						After creating, the AI will guide you through stack, governance, tooling, and pipeline setup — one question at a time.
					</p>
				</div>
			</div>

			{#if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger">
					{error}
				</div>
			{/if}

			<button
				onclick={createProject}
				disabled={!canCreate || creating}
				class="w-full bg-hub-cta text-hub-bg font-medium py-3 rounded-lg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{creating ? 'Creating...' : 'Create & Start Setup'}
			</button>
		</div>
	</div>
</div>
