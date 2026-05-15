<script setup lang="ts">
import AppSidebar from './AppSidebar.vue'
</script>

<template>
  <div class="flex min-h-screen bg-bg text-text">
    <AppSidebar />
    <main class="flex-1 overflow-x-hidden">
      <slot />
    </main>
  </div>
</template>
