<script setup lang="ts">
import { computed } from 'vue'
import mascotUrl from '../assets/mascot.png'

interface Props {
  /** 数値 (px) または sm/md/lg のプリセット。高さの基準値 */
  size?: number | 'sm' | 'md' | 'lg'
  /** 表情・状態。画像は固定だがアニメーションが変わる */
  mood?: 'idle' | 'talking' | 'happy'
  /**
   * 後方互換のために受け取るが、現在のマスコット画像では見た目に影響しない。
   * (旧 SVG 版で female/male の差分に使っていた)
   */
  gender?: 'female' | 'male'
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  mood: 'idle',
  gender: 'female',
})

const pxSize = computed(() => {
  if (typeof props.size === 'number') return props.size
  return { sm: 56, md: 96, lg: 160 }[props.size]
})

// idle はふわふわ浮く / talking は軽く弾む / happy はポヨンと一度
const animationClass = computed(() => {
  switch (props.mood) {
    case 'talking':
      return 'animate-bobble'
    case 'happy':
      return 'animate-pop'
    default:
      return 'animate-float'
  }
})
</script>

<template>
  <div
    class="inline-flex items-center justify-center"
    :class="animationClass"
    :style="{ width: `${pxSize}px`, height: `${pxSize}px` }"
  >
    <img
      :src="mascotUrl"
      alt="AIマスコット"
      class="h-full w-full select-none object-contain drop-shadow-sm"
      draggable="false"
    />
  </div>
</template>
