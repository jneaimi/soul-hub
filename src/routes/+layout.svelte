<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>Soul Hub</title>
</svelte:head>

<div class="h-screen overflow-hidden bg-hub-bg">
	{@render children()}
</div>
