// Optional human OAuth acceptance. Routine Test Lab runs use rehearsal.config.mjs.
import base from "./rehearsal.config.mjs";

export default {
  ...base,
  supabase: {
    ...base.supabase,
    authentication: {
      enableLocalSignup: true,
      environmentFile: ".env.rehearsal-service.local",
      providers: [
        {
          name: "google",
          clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
          clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
          skipNonceCheck: false,
          emailOptional: false,
        },
        {
          name: "github",
          clientIdEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_ID",
          clientSecretEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_SECRET",
          skipNonceCheck: false,
          emailOptional: false,
        },
      ],
    },
  },
};
