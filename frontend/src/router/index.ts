import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/Home.vue'),
    },
    {
      path: '/prototype',
      name: 'prototype',
      component: () => import('../views/Prototype.vue'),
    },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('../views/Chat.vue'),
    },
    {
      path: '/design-preview',
      name: 'design-preview',
      component: () => import('../views/DesignPreview.vue'),
    },
  ],
})

export default router