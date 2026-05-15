import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('../views/Onboarding.vue'),
      meta: { layout: 'minimal' },
    },
    { path: '/', name: 'home', component: () => import('../views/Home.vue') },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('../views/Chat.vue'),
    },
    {
      path: '/chat/summary',
      name: 'chat-summary',
      component: () => import('../views/ChatSummary.vue'),
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('../views/History.vue'),
    },
    {
      path: '/history/:id',
      name: 'history-detail',
      component: () => import('../views/HistoryDetail.vue'),
    },
    {
      path: '/vocabulary',
      name: 'vocabulary',
      component: () => import('../views/Vocabulary.vue'),
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('../views/Profile.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/Settings.vue'),
    },

    // Dev tools (Phase 1 holdovers)
    {
      path: '/prototype',
      name: 'prototype',
      component: () => import('../views/Prototype.vue'),
    },
    {
      path: '/components-preview',
      name: 'components-preview',
      component: () => import('../views/ComponentsPreview.vue'),
    },
  ],
})

export default router
