<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'
const props = withDefaults(defineProps<PrimitiveProps & { variant?: 'default' | 'outline' | 'ghost' | 'destructive'; class?: string }>(), { as: 'button', variant: 'default' })
const variants = cva('button', { variants: { variant: { default: 'button-primary', outline: 'button-outline', ghost: 'button-ghost', destructive: 'button-destructive' } } })
</script>
<template><Primitive :as="as" :as-child="asChild" :class="cn(variants({ variant }), props.class)"><slot /></Primitive></template>
