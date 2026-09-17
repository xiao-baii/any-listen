<script lang="ts">
  import Cover from './Cover.svelte'
  import Info from './Info.svelte'
  // let { introend }: { introend: boolean } = $props()
</script>

<div class="left-info">
  <Cover />
  <Info />
</div>

<style lang="less">
  .left-info {
    display: flex;
    flex: none;
    flex-flow: column nowrap;
    align-items: center;
    width: 50%;
    padding: 14px 15px 14px 20px;
    contain: strict;
    // transition: flex-basis @transition-normal;

    --content-width: 72%;
  }
  @media (max-width: 600px) {
    .left-info {
      box-sizing: border-box;
      flex-direction: row;
      gap: 16px;
      width: 100%;
      height: 100px;
      padding: 8px 20px;
      --content-width: 72px;
    }
  }
  @media (min-width: 601px) and (max-height: 500px) {
    .left-info {
      --content-width: min(72%, 28dvh);
      padding-top: 8px;
      padding-bottom: 8px;
    }
    .left-info > :global(.info) { width: 100%; }
  }
</style>
