# Maven And Gradle Build Dependencies

- Separate ordinary dependency repositories, plugin repositories, buildscript classpaths and machine-wide initialization scripts. They can have different source and execution authority.
- Verify repository order/content filtering, coordinates, selected version and the actual Maven or Gradle command. A repository URL alone does not establish that an attacker artifact is selectable.
- Build plugins and Gradle init scripts execute during build configuration or tasks, before application runtime. Trace who controls the plugin/script and what developer or CI credentials it can access.

Do not encode current Gradle/Maven defaults or plugin-version recommendations. Confirm behavior from the repository's wrapper/tool version and configuration.
