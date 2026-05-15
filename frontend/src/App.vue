<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from './components/AppShell.vue'

const route = useRoute()
const isMinimal = computed(() => route.meta?.layout === 'minimal')
</script>

<template>
  <AppShell v-if="!isMinimal">
    <router-view />
  </AppShell>
  <router-view v-else />
</template>
