if (!process.env.RELEASE_MODE) {
  console.log('Run `npm run pub` to publish the package')
  process.exit(1)
}
