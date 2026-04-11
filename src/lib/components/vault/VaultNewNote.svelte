<script lang="ts">
  import { onMount } from 'svelte';

  interface VaultZone {
    path: string;
    allowedTypes: string[];
    requireTemplate: boolean;
    requiredFields: string[];
    rawGovernance: string;
  }

  interface VaultTemplate {
    name: string;
    raw: string;
    requiredFields: string[];
    expectedSections: string[];
  }

  interface Props {
    zones: VaultZone[];
    onCreated: (path: string) => void;
    onClose: () => void;
  }

  let { zones, onCreated, onClose }: Props = $props();

  let step = $state<'template' | 'form'>('template');
  let templates = $state<VaultTemplate[]>([]);
  let loadingTemplates = $state(true);
  let selectedTemplate = $state<VaultTemplate | null>(null);

  let zone = $state('');
  let title = $state('');
  let tags = $state('');
  let content = $state('');
  let creating = $state(false);
  let formError = $state<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const filename = $derived(
    title.trim()
      ? `${today}-${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}.md`
      : ''
  );

  const templateIcons: Record<string, string> = {
    learning: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
    decision: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    debugging: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    pattern: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z',
    snippet: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
    research: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707',
    report: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    project: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  };

  async function loadTemplates() {
    loadingTemplates = true;
    try {
      const res = await fetch('/api/vault/templates');
      if (res.ok) {
        const data = await res.json();
        templates = data.templates;
      }
    } catch {
      // silent
    } finally {
      loadingTemplates = false;
    }
  }

  function pickTemplate(t: VaultTemplate) {
    selectedTemplate = t;
    step = 'form';
    content = t.raw;
    if (zones.length > 0) {
      zone = zones[0].path;
    }
  }

  function backToTemplates() {
    step = 'template';
    selectedTemplate = null;
    title = '';
    tags = '';
    content = '';
    formError = null;
  }

  async function createNote() {
    if (!title.trim()) {
      formError = 'Title is required';
      return;
    }
    if (!zone) {
      formError = 'Zone is required';
      return;
    }

    creating = true;
    formError = null;

    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const meta: Record<string, unknown> = {
      type: selectedTemplate?.name ?? 'learning',
      created: today,
      tags: tagList,
      title: title.trim(),
    };

    try {
      const res = await fetch('/api/vault/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zone,
          filename,
          meta,
          content: content.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || data.success === false) {
        formError = data.error || 'Failed to create note';
        return;
      }

      onCreated(data.path);
    } catch {
      formError = 'Network error';
    } finally {
      creating = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (step === 'form') {
        backToTemplates();
      } else {
        onClose();
      }
    }
  }

  onMount(() => {
    loadTemplates();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center" onkeydown={handleKeydown}>
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose}></div>

  <!-- Modal -->
  <div class="relative w-full max-w-xl mx-4 bg-hub-surface border border-hub-border rounded-xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
    <!-- Header -->
    <div class="flex items-center gap-3 px-4 py-3 border-b border-hub-border flex-shrink-0">
      {#if step === 'form'}
        <button onclick={backToTemplates} class="text-hub-muted hover:text-hub-text transition-colors">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </button>
      {/if}
      <h2 class="text-sm font-medium text-hub-text">
        {step === 'template' ? 'Choose a Template' : `New ${selectedTemplate?.name ?? 'Note'}`}
      </h2>
      <div class="flex-1"></div>
      <button onclick={onClose} class="text-hub-dim hover:text-hub-text transition-colors">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      {#if step === 'template'}
        {#if loadingTemplates}
          <div class="px-4 py-12 text-center text-hub-dim animate-pulse">Loading templates...</div>
        {:else if templates.length === 0}
          <div class="px-4 py-12 text-center text-hub-dim">No templates found</div>
        {:else}
          <div class="grid grid-cols-2 gap-3 p-4">
            {#each templates as t}
              <button
                class="text-left p-3 rounded-lg border border-hub-border bg-hub-card hover:border-hub-dim transition-colors group"
                onclick={() => pickTemplate(t)}
              >
                <div class="flex items-center gap-2 mb-2">
                  <svg class="w-4 h-4 text-hub-muted group-hover:text-hub-cta transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={templateIcons[t.name] ?? 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'} />
                  </svg>
                  <span class="text-sm font-medium text-hub-text capitalize">{t.name}</span>
                </div>
                {#if t.expectedSections.length > 0}
                  <div class="text-xs text-hub-dim">
                    {t.expectedSections.slice(0, 3).join(', ')}{t.expectedSections.length > 3 ? '...' : ''}
                  </div>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="p-4 space-y-4">
          <!-- Zone selector -->
          <div>
            <label class="block text-xs font-medium text-hub-dim mb-1" for="zone-select">Zone</label>
            <select
              id="zone-select"
              bind:value={zone}
              class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text outline-none focus:border-hub-cta transition-colors"
            >
              {#each zones as z}
                <option value={z.path}>{z.path}</option>
              {/each}
            </select>
          </div>

          <!-- Title -->
          <div>
            <label class="block text-xs font-medium text-hub-dim mb-1" for="title-input">Title</label>
            <input
              id="title-input"
              bind:value={title}
              type="text"
              placeholder="Note title"
              class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text outline-none focus:border-hub-cta transition-colors placeholder:text-hub-dim"
            />
          </div>

          <!-- Filename preview -->
          {#if filename}
            <div class="text-xs text-hub-dim">
              <span class="text-hub-muted">Filename:</span> {filename}
            </div>
          {/if}

          <!-- Tags -->
          <div>
            <label class="block text-xs font-medium text-hub-dim mb-1" for="tags-input">Tags (comma-separated)</label>
            <input
              id="tags-input"
              bind:value={tags}
              type="text"
              placeholder="tag1, tag2, tag3"
              class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text outline-none focus:border-hub-cta transition-colors placeholder:text-hub-dim"
            />
          </div>

          <!-- Content -->
          <div>
            <label class="block text-xs font-medium text-hub-dim mb-1" for="content-textarea">Content</label>
            <textarea
              id="content-textarea"
              bind:value={content}
              rows={10}
              class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text font-mono outline-none focus:border-hub-cta transition-colors resize-y placeholder:text-hub-dim"
              placeholder="Write your note..."
            ></textarea>
          </div>

          <!-- Error -->
          {#if formError}
            <div class="text-sm text-hub-danger bg-hub-danger/10 border border-hub-danger/20 rounded-lg px-3 py-2">
              {formError}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Footer -->
    {#if step === 'form'}
      <div class="flex-shrink-0 border-t border-hub-border px-4 py-3 flex items-center justify-end gap-3">
        <button
          onclick={onClose}
          class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text transition-colors"
        >Cancel</button>
        <button
          onclick={createNote}
          disabled={creating || !title.trim() || !zone}
          class="px-4 py-1.5 rounded-lg text-sm font-medium bg-hub-cta text-white hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? 'Creating...' : 'Create Note'}
        </button>
      </div>
    {/if}
  </div>
</div>
