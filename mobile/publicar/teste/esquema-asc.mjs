// GERADO por publicar/teste/gerar-esquema.mjs a partir da especificação oficial da
// App Store Connect API 4.6 (JSON OpenAPI publicado pela Apple). Não edite à mão:
// baixe a especificação nova e rode o gerador.

export const VERSAO_DA_ESPECIFICACAO = "4.6";

/** "MÉTODO /caminho/{id}" → parâmetros de consulta aceitos e o esquema do corpo. */
export const ROTAS = {
  "GET /v1/apps": {
    "parametros": {
      "filter[name]": {},
      "filter[bundleId]": {},
      "filter[sku]": {},
      "filter[appStoreVersions.appStoreState]": {
        "enum": [
          "ACCEPTED",
          "DEVELOPER_REMOVED_FROM_SALE",
          "DEVELOPER_REJECTED",
          "IN_REVIEW",
          "INVALID_BINARY",
          "METADATA_REJECTED",
          "PENDING_APPLE_RELEASE",
          "PENDING_CONTRACT",
          "PENDING_DEVELOPER_RELEASE",
          "PREPARE_FOR_SUBMISSION",
          "PREORDER_READY_FOR_SALE",
          "PROCESSING_FOR_APP_STORE",
          "READY_FOR_REVIEW",
          "READY_FOR_SALE",
          "REJECTED",
          "REMOVED_FROM_SALE",
          "WAITING_FOR_EXPORT_COMPLIANCE",
          "WAITING_FOR_REVIEW",
          "REPLACED_WITH_NEW_VERSION",
          "NOT_APPLICABLE"
        ]
      },
      "filter[appStoreVersions.platform]": {
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      },
      "filter[appStoreVersions.appVersionState]": {
        "enum": [
          "ACCEPTED",
          "DEVELOPER_REJECTED",
          "IN_REVIEW",
          "INVALID_BINARY",
          "METADATA_REJECTED",
          "PENDING_APPLE_RELEASE",
          "PENDING_DEVELOPER_RELEASE",
          "PREPARE_FOR_SUBMISSION",
          "PROCESSING_FOR_DISTRIBUTION",
          "READY_FOR_DISTRIBUTION",
          "READY_FOR_REVIEW",
          "REJECTED",
          "REPLACED_WITH_NEW_VERSION",
          "WAITING_FOR_EXPORT_COMPLIANCE",
          "WAITING_FOR_REVIEW"
        ]
      },
      "filter[reviewSubmissions.state]": {
        "enum": [
          "READY_FOR_REVIEW",
          "WAITING_FOR_REVIEW",
          "IN_REVIEW",
          "UNRESOLVED_ISSUES",
          "CANCELING",
          "COMPLETING",
          "COMPLETE"
        ]
      },
      "filter[reviewSubmissions.platform]": {
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      },
      "filter[appStoreVersions]": {},
      "filter[id]": {},
      "exists[gameCenterEnabledVersions]": {},
      "sort": {
        "enum": [
          "name",
          "-name",
          "bundleId",
          "-bundleId",
          "sku",
          "-sku"
        ]
      },
      "fields[apps]": {},
      "fields[appEncryptionDeclarations]": {},
      "fields[buildIcons]": {},
      "fields[ciProducts]": {},
      "fields[betaGroups]": {},
      "fields[appStoreVersions]": {},
      "fields[preReleaseVersions]": {},
      "fields[betaAppLocalizations]": {},
      "fields[builds]": {},
      "fields[betaLicenseAgreements]": {},
      "fields[betaAppReviewDetails]": {},
      "fields[appInfos]": {},
      "fields[appClips]": {},
      "fields[endUserLicenseAgreements]": {},
      "fields[inAppPurchases]": {},
      "fields[subscriptionGroups]": {},
      "fields[retentionMessages]": {},
      "fields[gameCenterEnabledVersions]": {},
      "fields[appCustomProductPages]": {},
      "fields[promotedPurchases]": {},
      "fields[appEvents]": {},
      "fields[reviewSubmissions]": {},
      "fields[subscriptionGracePeriods]": {},
      "fields[gameCenterDetails]": {},
      "fields[appStoreVersionExperiments]": {},
      "fields[androidToIosAppMappingDetails]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "appEncryptionDeclarations",
          "appStoreIcon",
          "ciProduct",
          "betaGroups",
          "appStoreVersions",
          "preReleaseVersions",
          "betaAppLocalizations",
          "builds",
          "betaLicenseAgreement",
          "betaAppReviewDetail",
          "appInfos",
          "appClips",
          "endUserLicenseAgreement",
          "inAppPurchases",
          "subscriptionGroups",
          "retentionMessages",
          "gameCenterEnabledVersions",
          "appCustomProductPages",
          "inAppPurchasesV2",
          "promotedPurchases",
          "appEvents",
          "reviewSubmissions",
          "subscriptionGracePeriod",
          "gameCenterDetail",
          "appStoreVersionExperimentsV2",
          "androidToIosAppMappingDetails"
        ]
      },
      "limit[androidToIosAppMappingDetails]": {
        "maximo": 50
      },
      "limit[appClips]": {
        "maximo": 50
      },
      "limit[appCustomProductPages]": {
        "maximo": 50
      },
      "limit[appEncryptionDeclarations]": {
        "maximo": 50
      },
      "limit[appEvents]": {
        "maximo": 50
      },
      "limit[appInfos]": {
        "maximo": 50
      },
      "limit[appStoreVersionExperimentsV2]": {
        "maximo": 50
      },
      "limit[appStoreVersions]": {
        "maximo": 50
      },
      "limit[betaAppLocalizations]": {
        "maximo": 50
      },
      "limit[betaGroups]": {
        "maximo": 50
      },
      "limit[builds]": {
        "maximo": 50
      },
      "limit[gameCenterEnabledVersions]": {
        "maximo": 50
      },
      "limit[inAppPurchases]": {
        "maximo": 50
      },
      "limit[inAppPurchasesV2]": {
        "maximo": 50
      },
      "limit[preReleaseVersions]": {
        "maximo": 50
      },
      "limit[promotedPurchases]": {
        "maximo": 50
      },
      "limit[retentionMessages]": {
        "maximo": 50
      },
      "limit[reviewSubmissions]": {
        "maximo": 50
      },
      "limit[subscriptionGroups]": {
        "maximo": 50
      }
    }
  },
  "PATCH /v1/apps/{id}": {
    "corpo": "AppUpdateRequest"
  },
  "GET /v1/apps/{id}/appInfos": {
    "parametros": {
      "fields[appInfos]": {},
      "fields[apps]": {},
      "fields[ageRatingDeclarations]": {},
      "fields[appInfoLocalizations]": {},
      "fields[appCategories]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "app",
          "ageRatingDeclaration",
          "appInfoLocalizations",
          "primaryCategory",
          "primarySubcategoryOne",
          "primarySubcategoryTwo",
          "secondaryCategory",
          "secondarySubcategoryOne",
          "secondarySubcategoryTwo"
        ]
      },
      "limit[appInfoLocalizations]": {
        "maximo": 50
      }
    }
  },
  "GET /v1/appInfos/{id}/appInfoLocalizations": {
    "parametros": {
      "filter[locale]": {},
      "fields[appInfoLocalizations]": {},
      "fields[appInfos]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "appInfo"
        ]
      }
    }
  },
  "POST /v1/appInfoLocalizations": {
    "corpo": "AppInfoLocalizationCreateRequest"
  },
  "PATCH /v1/appInfoLocalizations/{id}": {
    "corpo": "AppInfoLocalizationUpdateRequest"
  },
  "DELETE /v1/appInfoLocalizations/{id}": {},
  "PATCH /v1/appInfos/{id}": {
    "corpo": "AppInfoUpdateRequest"
  },
  "GET /v1/appInfos/{id}/ageRatingDeclaration": {
    "parametros": {
      "fields[ageRatingDeclarations]": {}
    }
  },
  "PATCH /v1/ageRatingDeclarations/{id}": {
    "corpo": "AgeRatingDeclarationUpdateRequest"
  },
  "GET /v1/apps/{id}/appAvailabilityV2": {
    "parametros": {
      "fields[appAvailabilities]": {},
      "fields[territoryAvailabilities]": {},
      "include": {
        "enum": [
          "territoryAvailabilities"
        ]
      },
      "limit[territoryAvailabilities]": {
        "maximo": 50
      }
    }
  },
  "GET /v2/appAvailabilities/{id}/territoryAvailabilities": {
    "parametros": {
      "fields[territoryAvailabilities]": {},
      "fields[territories]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "territory"
        ]
      }
    }
  },
  "POST /v2/appAvailabilities": {
    "corpo": "AppAvailabilityV2CreateRequest"
  },
  "GET /v1/apps/{id}/appStoreVersions": {
    "parametros": {
      "filter[platform]": {
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      },
      "filter[versionString]": {},
      "filter[appStoreState]": {
        "enum": [
          "ACCEPTED",
          "DEVELOPER_REMOVED_FROM_SALE",
          "DEVELOPER_REJECTED",
          "IN_REVIEW",
          "INVALID_BINARY",
          "METADATA_REJECTED",
          "PENDING_APPLE_RELEASE",
          "PENDING_CONTRACT",
          "PENDING_DEVELOPER_RELEASE",
          "PREPARE_FOR_SUBMISSION",
          "PREORDER_READY_FOR_SALE",
          "PROCESSING_FOR_APP_STORE",
          "READY_FOR_REVIEW",
          "READY_FOR_SALE",
          "REJECTED",
          "REMOVED_FROM_SALE",
          "WAITING_FOR_EXPORT_COMPLIANCE",
          "WAITING_FOR_REVIEW",
          "REPLACED_WITH_NEW_VERSION",
          "NOT_APPLICABLE"
        ]
      },
      "filter[appVersionState]": {
        "enum": [
          "ACCEPTED",
          "DEVELOPER_REJECTED",
          "IN_REVIEW",
          "INVALID_BINARY",
          "METADATA_REJECTED",
          "PENDING_APPLE_RELEASE",
          "PENDING_DEVELOPER_RELEASE",
          "PREPARE_FOR_SUBMISSION",
          "PROCESSING_FOR_DISTRIBUTION",
          "READY_FOR_DISTRIBUTION",
          "READY_FOR_REVIEW",
          "REJECTED",
          "REPLACED_WITH_NEW_VERSION",
          "WAITING_FOR_EXPORT_COMPLIANCE",
          "WAITING_FOR_REVIEW"
        ]
      },
      "filter[id]": {},
      "fields[appStoreVersions]": {},
      "fields[apps]": {},
      "fields[appStoreVersionLocalizations]": {},
      "fields[builds]": {},
      "fields[appStoreVersionPhasedReleases]": {},
      "fields[gameCenterAppVersions]": {},
      "fields[routingAppCoverages]": {},
      "fields[appStoreReviewDetails]": {},
      "fields[appStoreVersionSubmissions]": {},
      "fields[appClipDefaultExperiences]": {},
      "fields[appStoreVersionExperiments]": {},
      "fields[alternativeDistributionPackages]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "app",
          "appStoreVersionLocalizations",
          "build",
          "appStoreVersionPhasedRelease",
          "gameCenterAppVersion",
          "routingAppCoverage",
          "appStoreReviewDetail",
          "appStoreVersionSubmission",
          "appClipDefaultExperience",
          "appStoreVersionExperiments",
          "appStoreVersionExperimentsV2",
          "alternativeDistributionPackage"
        ]
      },
      "limit[appStoreVersionLocalizations]": {
        "maximo": 50
      },
      "limit[appStoreVersionExperiments]": {
        "maximo": 50
      },
      "limit[appStoreVersionExperimentsV2]": {
        "maximo": 50
      }
    }
  },
  "POST /v1/appStoreVersions": {
    "corpo": "AppStoreVersionCreateRequest"
  },
  "PATCH /v1/appStoreVersions/{id}": {
    "corpo": "AppStoreVersionUpdateRequest"
  },
  "GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations": {
    "parametros": {
      "filter[locale]": {},
      "fields[appStoreVersionLocalizations]": {},
      "fields[appStoreVersions]": {},
      "fields[appScreenshotSets]": {},
      "fields[appPreviewSets]": {},
      "fields[appKeywords]": {},
      "fields[appAssetLibraryPlacements]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "appStoreVersion",
          "appScreenshotSets",
          "appPreviewSets",
          "searchKeywords",
          "placements"
        ]
      },
      "limit[appScreenshotSets]": {
        "maximo": 50
      },
      "limit[appPreviewSets]": {
        "maximo": 50
      },
      "limit[searchKeywords]": {
        "maximo": 50
      },
      "limit[placements]": {
        "maximo": 50
      }
    }
  },
  "POST /v1/appStoreVersionLocalizations": {
    "corpo": "AppStoreVersionLocalizationCreateRequest"
  },
  "PATCH /v1/appStoreVersionLocalizations/{id}": {
    "corpo": "AppStoreVersionLocalizationUpdateRequest"
  },
  "DELETE /v1/appStoreVersionLocalizations/{id}": {},
  "GET /v1/appStoreVersionLocalizations/{id}/appScreenshotSets": {
    "parametros": {
      "filter[screenshotDisplayType]": {
        "enum": [
          "APP_IPHONE_67",
          "APP_IPHONE_61",
          "APP_IPHONE_65",
          "APP_IPHONE_58",
          "APP_IPHONE_55",
          "APP_IPHONE_47",
          "APP_IPHONE_40",
          "APP_IPHONE_35",
          "APP_IPAD_PRO_3GEN_129",
          "APP_IPAD_PRO_3GEN_11",
          "APP_IPAD_PRO_129",
          "APP_IPAD_105",
          "APP_IPAD_97",
          "APP_DESKTOP",
          "APP_WATCH_ULTRA",
          "APP_WATCH_SERIES_10",
          "APP_WATCH_SERIES_7",
          "APP_WATCH_SERIES_4",
          "APP_WATCH_SERIES_3",
          "APP_APPLE_TV",
          "APP_APPLE_VISION_PRO",
          "IMESSAGE_APP_IPHONE_67",
          "IMESSAGE_APP_IPHONE_61",
          "IMESSAGE_APP_IPHONE_65",
          "IMESSAGE_APP_IPHONE_58",
          "IMESSAGE_APP_IPHONE_55",
          "IMESSAGE_APP_IPHONE_47",
          "IMESSAGE_APP_IPHONE_40",
          "IMESSAGE_APP_IPAD_PRO_3GEN_129",
          "IMESSAGE_APP_IPAD_PRO_3GEN_11",
          "IMESSAGE_APP_IPAD_PRO_129",
          "IMESSAGE_APP_IPAD_105",
          "IMESSAGE_APP_IPAD_97"
        ]
      },
      "filter[appCustomProductPageLocalization]": {},
      "filter[appStoreVersionExperimentTreatmentLocalization]": {},
      "fields[appScreenshotSets]": {},
      "fields[appStoreVersionLocalizations]": {},
      "fields[appCustomProductPageLocalizations]": {},
      "fields[appStoreVersionExperimentTreatmentLocalizations]": {},
      "fields[appScreenshots]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "appStoreVersionLocalization",
          "appCustomProductPageLocalization",
          "appStoreVersionExperimentTreatmentLocalization",
          "appScreenshots"
        ]
      },
      "limit[appScreenshots]": {
        "maximo": 50
      }
    }
  },
  "POST /v1/appScreenshotSets": {
    "corpo": "AppScreenshotSetCreateRequest"
  },
  "DELETE /v1/appScreenshotSets/{id}": {},
  "GET /v1/appScreenshotSets/{id}/appScreenshots": {
    "parametros": {
      "fields[appScreenshots]": {},
      "fields[appScreenshotSets]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "appScreenshotSet"
        ]
      }
    }
  },
  "PATCH /v1/appScreenshotSets/{id}/relationships/appScreenshots": {
    "corpo": "AppScreenshotSetAppScreenshotsLinkagesRequest"
  },
  "POST /v1/appScreenshots": {
    "corpo": "AppScreenshotCreateRequest"
  },
  "PATCH /v1/appScreenshots/{id}": {
    "corpo": "AppScreenshotUpdateRequest"
  },
  "DELETE /v1/appScreenshots/{id}": {},
  "GET /v1/appStoreVersions/{id}/appStoreReviewDetail": {
    "parametros": {
      "fields[appStoreReviewDetails]": {},
      "fields[appStoreVersions]": {},
      "fields[appStoreReviewAttachments]": {},
      "include": {
        "enum": [
          "appStoreVersion",
          "appStoreReviewAttachments"
        ]
      },
      "limit[appStoreReviewAttachments]": {
        "maximo": 50
      }
    }
  },
  "POST /v1/appStoreReviewDetails": {
    "corpo": "AppStoreReviewDetailCreateRequest"
  },
  "PATCH /v1/appStoreReviewDetails/{id}": {
    "corpo": "AppStoreReviewDetailUpdateRequest"
  },
  "GET /v1/appStoreReviewDetails/{id}/appStoreReviewAttachments": {
    "parametros": {
      "fields[appStoreReviewAttachments]": {},
      "fields[appStoreReviewDetails]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "appStoreReviewDetail"
        ]
      }
    }
  },
  "POST /v1/appStoreReviewAttachments": {
    "corpo": "AppStoreReviewAttachmentCreateRequest"
  },
  "GET /v1/appStoreReviewAttachments/{id}": {
    "parametros": {
      "fields[appStoreReviewAttachments]": {},
      "fields[appStoreReviewDetails]": {},
      "include": {
        "enum": [
          "appStoreReviewDetail"
        ]
      }
    }
  },
  "PATCH /v1/appStoreReviewAttachments/{id}": {
    "corpo": "AppStoreReviewAttachmentUpdateRequest"
  },
  "DELETE /v1/appStoreReviewAttachments/{id}": {},
  "GET /v1/apps/{id}/appPricePoints": {
    "parametros": {
      "filter[territory]": {},
      "fields[appPricePoints]": {},
      "fields[apps]": {},
      "fields[territories]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "app",
          "territory"
        ]
      }
    }
  },
  "POST /v1/appPriceSchedules": {
    "corpo": "AppPriceScheduleCreateRequest"
  },
  "GET /v1/builds": {
    "parametros": {
      "filter[version]": {},
      "filter[expired]": {},
      "filter[processingState]": {
        "enum": [
          "PROCESSING",
          "FAILED",
          "INVALID",
          "VALID"
        ]
      },
      "filter[betaAppReviewSubmission.betaReviewState]": {
        "enum": [
          "WAITING_FOR_REVIEW",
          "IN_REVIEW",
          "REJECTED",
          "APPROVED"
        ]
      },
      "filter[usesNonExemptEncryption]": {},
      "filter[preReleaseVersion.version]": {},
      "filter[preReleaseVersion.platform]": {
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      },
      "filter[buildAudienceType]": {
        "enum": [
          "INTERNAL_ONLY",
          "APP_STORE_ELIGIBLE"
        ]
      },
      "filter[preReleaseVersion]": {},
      "filter[app]": {},
      "filter[betaGroups]": {},
      "filter[appStoreVersion]": {},
      "filter[id]": {},
      "exists[usesNonExemptEncryption]": {},
      "sort": {
        "enum": [
          "version",
          "-version",
          "uploadedDate",
          "-uploadedDate",
          "preReleaseVersion",
          "-preReleaseVersion"
        ]
      },
      "fields[builds]": {},
      "fields[preReleaseVersions]": {},
      "fields[betaTesters]": {},
      "fields[betaGroups]": {},
      "fields[betaBuildLocalizations]": {},
      "fields[appEncryptionDeclarations]": {},
      "fields[betaAppReviewSubmissions]": {},
      "fields[apps]": {},
      "fields[buildBetaDetails]": {},
      "fields[appStoreVersions]": {},
      "fields[buildIcons]": {},
      "fields[buildBundles]": {},
      "fields[buildUploads]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "preReleaseVersion",
          "individualTesters",
          "betaGroups",
          "betaBuildLocalizations",
          "appEncryptionDeclaration",
          "betaAppReviewSubmission",
          "app",
          "buildBetaDetail",
          "appStoreVersion",
          "icons",
          "buildBundles",
          "buildUpload"
        ]
      },
      "limit[betaBuildLocalizations]": {
        "maximo": 50
      },
      "limit[betaGroups]": {
        "maximo": 50
      },
      "limit[buildBundles]": {
        "maximo": 50
      },
      "limit[icons]": {
        "maximo": 50
      },
      "limit[individualTesters]": {
        "maximo": 50
      }
    }
  },
  "GET /v1/appStoreVersions/{id}/build": {
    "parametros": {
      "fields[builds]": {}
    }
  },
  "PATCH /v1/appStoreVersions/{id}/relationships/build": {
    "corpo": "AppStoreVersionBuildLinkageRequest"
  },
  "GET /v1/reviewSubmissions": {
    "parametros": {
      "filter[platform]": {
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      },
      "filter[state]": {
        "enum": [
          "READY_FOR_REVIEW",
          "WAITING_FOR_REVIEW",
          "IN_REVIEW",
          "UNRESOLVED_ISSUES",
          "CANCELING",
          "COMPLETING",
          "COMPLETE"
        ]
      },
      "filter[app]": {
        "obrigatorio": true
      },
      "fields[reviewSubmissions]": {},
      "fields[apps]": {},
      "fields[reviewSubmissionItems]": {},
      "fields[appStoreVersions]": {},
      "fields[actors]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "app",
          "items",
          "appStoreVersionForReview",
          "submittedByActor",
          "lastUpdatedByActor"
        ]
      },
      "limit[items]": {
        "maximo": 50
      }
    }
  },
  "POST /v1/reviewSubmissions": {
    "corpo": "ReviewSubmissionCreateRequest"
  },
  "PATCH /v1/reviewSubmissions/{id}": {
    "corpo": "ReviewSubmissionUpdateRequest"
  },
  "GET /v1/reviewSubmissions/{id}/items": {
    "parametros": {
      "fields[reviewSubmissionItems]": {},
      "fields[appStoreVersions]": {},
      "fields[appCustomProductPageVersions]": {},
      "fields[appStoreVersionExperiments]": {},
      "fields[appEvents]": {},
      "fields[appAssetLibraryImages]": {},
      "fields[appAssetLibraryVideos]": {},
      "fields[backgroundAssetVersions]": {},
      "fields[gameCenterAchievementVersions]": {},
      "fields[gameCenterActivityVersions]": {},
      "fields[gameCenterChallengeVersions]": {},
      "fields[gameCenterLeaderboardSetVersions]": {},
      "fields[gameCenterLeaderboardVersions]": {},
      "fields[inAppPurchaseVersions]": {},
      "fields[subscriptionVersions]": {},
      "fields[subscriptionGroupVersions]": {},
      "fields[retentionMessageVersions]": {},
      "limit": {
        "maximo": 200
      },
      "include": {
        "enum": [
          "appStoreVersion",
          "appCustomProductPageVersion",
          "appStoreVersionExperiment",
          "appStoreVersionExperimentV2",
          "appEvent",
          "appAssetLibraryImage",
          "appAssetLibraryVideo",
          "backgroundAssetVersion",
          "gameCenterAchievementVersion",
          "gameCenterActivityVersion",
          "gameCenterChallengeVersion",
          "gameCenterLeaderboardSetVersion",
          "gameCenterLeaderboardVersion",
          "inAppPurchaseVersion",
          "subscriptionVersion",
          "subscriptionGroupVersion",
          "retentionMessageVersion"
        ]
      }
    }
  },
  "POST /v1/reviewSubmissionItems": {
    "corpo": "ReviewSubmissionItemCreateRequest"
  },
  "PATCH /v1/reviewSubmissionItems/{id}": {
    "corpo": "ReviewSubmissionItemUpdateRequest"
  },
  "GET /v1/devices": {
    "parametros": {
      "filter[name]": {},
      "filter[platform]": {
        "enum": [
          "IOS",
          "MAC_OS",
          "UNIVERSAL"
        ]
      },
      "filter[udid]": {},
      "filter[status]": {
        "enum": [
          "ENABLED",
          "DISABLED"
        ]
      },
      "filter[id]": {},
      "sort": {
        "enum": [
          "name",
          "-name",
          "platform",
          "-platform",
          "udid",
          "-udid",
          "status",
          "-status",
          "id",
          "-id"
        ]
      },
      "fields[devices]": {},
      "limit": {
        "maximo": 200
      }
    }
  },
  "POST /v1/devices": {
    "corpo": "DeviceCreateRequest"
  }
};

/** Esquema → formato do corpo (data.type, id, atributos com tipo/enum/nulo, relações, included). */
export const CORPOS = {
  "AgeRatingDeclarationUpdateRequest": {
    "tipo": "ageRatingDeclarations",
    "id": "obrigatorio",
    "atributos": {
      "advertising": {
        "t": "boolean",
        "nulo": true
      },
      "alcoholTobaccoOrDrugUseOrReferences": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "contests": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "gambling": {
        "t": "boolean",
        "nulo": true
      },
      "gamblingSimulated": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "gunsOrOtherWeapons": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "healthOrWellnessTopics": {
        "t": "boolean",
        "nulo": true
      },
      "kidsAgeBand": {
        "t": "string",
        "nulo": true,
        "enum": [
          "FIVE_AND_UNDER",
          "SIX_TO_EIGHT",
          "NINE_TO_ELEVEN"
        ]
      },
      "lootBox": {
        "t": "boolean",
        "nulo": true
      },
      "medicalOrTreatmentInformation": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "messagingAndChat": {
        "t": "boolean",
        "nulo": true
      },
      "parentalControls": {
        "t": "boolean",
        "nulo": true
      },
      "profanityOrCrudeHumor": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "ageAssurance": {
        "t": "boolean",
        "nulo": true
      },
      "sexualContentGraphicAndNudity": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "sexualContentOrNudity": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "socialMedia": {
        "t": "boolean",
        "nulo": true
      },
      "socialMediaAgeRestricted": {
        "t": "boolean",
        "nulo": true
      },
      "horrorOrFearThemes": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "matureOrSuggestiveThemes": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "unrestrictedWebAccess": {
        "t": "boolean",
        "nulo": true
      },
      "userGeneratedContent": {
        "t": "boolean",
        "nulo": true
      },
      "violenceCartoonOrFantasy": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "violenceRealisticProlongedGraphicOrSadistic": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "violenceRealistic": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "INFREQUENT_OR_MILD",
          "FREQUENT_OR_INTENSE",
          "INFREQUENT",
          "FREQUENT"
        ]
      },
      "ageRatingOverride": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "NINE_PLUS",
          "THIRTEEN_PLUS",
          "SIXTEEN_PLUS",
          "SEVENTEEN_PLUS",
          "UNRATED"
        ]
      },
      "ageRatingOverrideV2": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "NINE_PLUS",
          "THIRTEEN_PLUS",
          "SIXTEEN_PLUS",
          "EIGHTEEN_PLUS",
          "UNRATED"
        ]
      },
      "koreaAgeRatingOverride": {
        "t": "string",
        "nulo": true,
        "enum": [
          "NONE",
          "ALL",
          "TWELVE_PLUS",
          "FIFTEEN_PLUS",
          "NINETEEN_PLUS"
        ]
      },
      "gracRatingClassificationNumber": {
        "t": "string",
        "nulo": true
      },
      "developerAgeRatingInfoUrl": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "AppAvailabilityV2CreateRequest": {
    "tipo": "appAvailabilities",
    "id": "proibido",
    "atributos": {
      "availableInNewTerritories": {
        "t": "boolean"
      }
    },
    "atributosObrigatorios": [
      "availableInNewTerritories"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {
      "app": {
        "tipo": "apps",
        "lista": false
      },
      "territoryAvailabilities": {
        "tipo": "territoryAvailabilities",
        "lista": true
      }
    },
    "relacoesObrigatorias": [
      "app",
      "territoryAvailabilities"
    ],
    "incluidos": [
      "TerritoryAvailabilityInlineCreate"
    ]
  },
  "AppInfoLocalizationCreateRequest": {
    "tipo": "appInfoLocalizations",
    "id": "proibido",
    "atributos": {
      "locale": {
        "t": "string"
      },
      "name": {
        "t": "string"
      },
      "subtitle": {
        "t": "string",
        "nulo": true
      },
      "privacyPolicyUrl": {
        "t": "string",
        "nulo": true
      },
      "privacyChoicesUrl": {
        "t": "string",
        "nulo": true
      },
      "privacyPolicyText": {
        "t": "string",
        "nulo": true
      }
    },
    "atributosObrigatorios": [
      "name",
      "locale"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {
      "appInfo": {
        "tipo": "appInfos",
        "lista": false
      }
    },
    "relacoesObrigatorias": [
      "appInfo"
    ]
  },
  "AppInfoLocalizationUpdateRequest": {
    "tipo": "appInfoLocalizations",
    "id": "obrigatorio",
    "atributos": {
      "name": {
        "t": "string",
        "nulo": true
      },
      "subtitle": {
        "t": "string",
        "nulo": true
      },
      "privacyPolicyUrl": {
        "t": "string",
        "nulo": true
      },
      "privacyChoicesUrl": {
        "t": "string",
        "nulo": true
      },
      "privacyPolicyText": {
        "t": "string",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "AppInfoUpdateRequest": {
    "tipo": "appInfos",
    "id": "obrigatorio",
    "atributos": {},
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "primaryCategory": {
        "tipo": "appCategories",
        "lista": false
      },
      "primarySubcategoryOne": {
        "tipo": "appCategories",
        "lista": false
      },
      "primarySubcategoryTwo": {
        "tipo": "appCategories",
        "lista": false
      },
      "secondaryCategory": {
        "tipo": "appCategories",
        "lista": false
      },
      "secondarySubcategoryOne": {
        "tipo": "appCategories",
        "lista": false
      },
      "secondarySubcategoryTwo": {
        "tipo": "appCategories",
        "lista": false
      }
    },
    "relacoesObrigatorias": []
  },
  "AppPriceScheduleCreateRequest": {
    "tipo": "appPriceSchedules",
    "id": "proibido",
    "atributos": {},
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "app": {
        "tipo": "apps",
        "lista": false
      },
      "baseTerritory": {
        "tipo": "territories",
        "lista": false
      },
      "manualPrices": {
        "tipo": "appPrices",
        "lista": true
      }
    },
    "relacoesObrigatorias": [
      "app",
      "manualPrices",
      "baseTerritory"
    ],
    "incluidos": [
      "AppPriceV2InlineCreate",
      "TerritoryInlineCreate"
    ]
  },
  "AppScreenshotCreateRequest": {
    "tipo": "appScreenshots",
    "id": "proibido",
    "atributos": {
      "fileSize": {
        "t": "integer"
      },
      "fileName": {
        "t": "string"
      }
    },
    "atributosObrigatorios": [
      "fileName",
      "fileSize"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {
      "appScreenshotSet": {
        "tipo": "appScreenshotSets",
        "lista": false
      }
    },
    "relacoesObrigatorias": [
      "appScreenshotSet"
    ]
  },
  "AppScreenshotSetAppScreenshotsLinkagesRequest": {
    "lista": true,
    "tipo": "appScreenshots"
  },
  "AppScreenshotSetCreateRequest": {
    "tipo": "appScreenshotSets",
    "id": "proibido",
    "atributos": {
      "screenshotDisplayType": {
        "t": "string",
        "enum": [
          "APP_IPHONE_67",
          "APP_IPHONE_61",
          "APP_IPHONE_65",
          "APP_IPHONE_58",
          "APP_IPHONE_55",
          "APP_IPHONE_47",
          "APP_IPHONE_40",
          "APP_IPHONE_35",
          "APP_IPAD_PRO_3GEN_129",
          "APP_IPAD_PRO_3GEN_11",
          "APP_IPAD_PRO_129",
          "APP_IPAD_105",
          "APP_IPAD_97",
          "APP_DESKTOP",
          "APP_WATCH_ULTRA",
          "APP_WATCH_SERIES_10",
          "APP_WATCH_SERIES_7",
          "APP_WATCH_SERIES_4",
          "APP_WATCH_SERIES_3",
          "APP_APPLE_TV",
          "APP_APPLE_VISION_PRO",
          "IMESSAGE_APP_IPHONE_67",
          "IMESSAGE_APP_IPHONE_61",
          "IMESSAGE_APP_IPHONE_65",
          "IMESSAGE_APP_IPHONE_58",
          "IMESSAGE_APP_IPHONE_55",
          "IMESSAGE_APP_IPHONE_47",
          "IMESSAGE_APP_IPHONE_40",
          "IMESSAGE_APP_IPAD_PRO_3GEN_129",
          "IMESSAGE_APP_IPAD_PRO_3GEN_11",
          "IMESSAGE_APP_IPAD_PRO_129",
          "IMESSAGE_APP_IPAD_105",
          "IMESSAGE_APP_IPAD_97"
        ]
      }
    },
    "atributosObrigatorios": [
      "screenshotDisplayType"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {
      "appStoreVersionLocalization": {
        "tipo": "appStoreVersionLocalizations",
        "lista": false
      },
      "appCustomProductPageLocalization": {
        "tipo": "appCustomProductPageLocalizations",
        "lista": false
      },
      "appStoreVersionExperimentTreatmentLocalization": {
        "tipo": "appStoreVersionExperimentTreatmentLocalizations",
        "lista": false
      }
    },
    "relacoesObrigatorias": []
  },
  "AppScreenshotUpdateRequest": {
    "tipo": "appScreenshots",
    "id": "obrigatorio",
    "atributos": {
      "sourceFileChecksum": {
        "t": "string",
        "nulo": true
      },
      "uploaded": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "AppStoreReviewAttachmentCreateRequest": {
    "tipo": "appStoreReviewAttachments",
    "id": "proibido",
    "atributos": {
      "fileSize": {
        "t": "integer"
      },
      "fileName": {
        "t": "string"
      }
    },
    "atributosObrigatorios": [
      "fileName",
      "fileSize"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {
      "appStoreReviewDetail": {
        "tipo": "appStoreReviewDetails",
        "lista": false
      }
    },
    "relacoesObrigatorias": [
      "appStoreReviewDetail"
    ]
  },
  "AppStoreReviewAttachmentUpdateRequest": {
    "tipo": "appStoreReviewAttachments",
    "id": "obrigatorio",
    "atributos": {
      "sourceFileChecksum": {
        "t": "string",
        "nulo": true
      },
      "uploaded": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "AppStoreReviewDetailCreateRequest": {
    "tipo": "appStoreReviewDetails",
    "id": "proibido",
    "atributos": {
      "contactFirstName": {
        "t": "string",
        "nulo": true
      },
      "contactLastName": {
        "t": "string",
        "nulo": true
      },
      "contactPhone": {
        "t": "string",
        "nulo": true
      },
      "contactEmail": {
        "t": "string",
        "nulo": true
      },
      "demoAccountName": {
        "t": "string",
        "nulo": true
      },
      "demoAccountPassword": {
        "t": "string",
        "nulo": true
      },
      "demoAccountRequired": {
        "t": "boolean",
        "nulo": true
      },
      "notes": {
        "t": "string",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "appStoreVersion": {
        "tipo": "appStoreVersions",
        "lista": false
      }
    },
    "relacoesObrigatorias": [
      "appStoreVersion"
    ]
  },
  "AppStoreReviewDetailUpdateRequest": {
    "tipo": "appStoreReviewDetails",
    "id": "obrigatorio",
    "atributos": {
      "contactFirstName": {
        "t": "string",
        "nulo": true
      },
      "contactLastName": {
        "t": "string",
        "nulo": true
      },
      "contactPhone": {
        "t": "string",
        "nulo": true
      },
      "contactEmail": {
        "t": "string",
        "nulo": true
      },
      "demoAccountName": {
        "t": "string",
        "nulo": true
      },
      "demoAccountPassword": {
        "t": "string",
        "nulo": true
      },
      "demoAccountRequired": {
        "t": "boolean",
        "nulo": true
      },
      "notes": {
        "t": "string",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "AppStoreVersionBuildLinkageRequest": {
    "tipo": "builds",
    "id": "obrigatorio",
    "atributos": {},
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "AppStoreVersionCreateRequest": {
    "tipo": "appStoreVersions",
    "id": "proibido",
    "atributos": {
      "platform": {
        "t": "string",
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      },
      "versionString": {
        "t": "string"
      },
      "copyright": {
        "t": "string",
        "nulo": true
      },
      "reviewType": {
        "t": "string",
        "nulo": true,
        "enum": [
          "APP_STORE",
          "NOTARIZATION"
        ]
      },
      "releaseType": {
        "t": "string",
        "nulo": true,
        "enum": [
          "MANUAL",
          "AFTER_APPROVAL",
          "SCHEDULED"
        ]
      },
      "earliestReleaseDate": {
        "t": "string",
        "nulo": true,
        "formato": "date-time"
      },
      "usesIdfa": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [
      "versionString",
      "platform"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {
      "app": {
        "tipo": "apps",
        "lista": false
      },
      "appStoreVersionLocalizations": {
        "tipo": "appStoreVersionLocalizations",
        "lista": true
      },
      "build": {
        "tipo": "builds",
        "lista": false
      }
    },
    "relacoesObrigatorias": [
      "app"
    ]
  },
  "AppStoreVersionLocalizationCreateRequest": {
    "tipo": "appStoreVersionLocalizations",
    "id": "proibido",
    "atributos": {
      "description": {
        "t": "string",
        "nulo": true
      },
      "locale": {
        "t": "string"
      },
      "keywords": {
        "t": "string",
        "nulo": true
      },
      "marketingUrl": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      },
      "promotionalText": {
        "t": "string",
        "nulo": true
      },
      "supportUrl": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      },
      "whatsNew": {
        "t": "string",
        "nulo": true
      }
    },
    "atributosObrigatorios": [
      "locale"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {
      "appStoreVersion": {
        "tipo": "appStoreVersions",
        "lista": false
      },
      "placements": {
        "tipo": "appAssetLibraryPlacements",
        "lista": true
      }
    },
    "relacoesObrigatorias": [
      "appStoreVersion"
    ]
  },
  "AppStoreVersionLocalizationUpdateRequest": {
    "tipo": "appStoreVersionLocalizations",
    "id": "obrigatorio",
    "atributos": {
      "description": {
        "t": "string",
        "nulo": true
      },
      "keywords": {
        "t": "string",
        "nulo": true
      },
      "marketingUrl": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      },
      "promotionalText": {
        "t": "string",
        "nulo": true
      },
      "supportUrl": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      },
      "whatsNew": {
        "t": "string",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "AppStoreVersionUpdateRequest": {
    "tipo": "appStoreVersions",
    "id": "obrigatorio",
    "atributos": {
      "versionString": {
        "t": "string",
        "nulo": true
      },
      "copyright": {
        "t": "string",
        "nulo": true
      },
      "reviewType": {
        "t": "string",
        "nulo": true,
        "enum": [
          "APP_STORE",
          "NOTARIZATION"
        ]
      },
      "releaseType": {
        "t": "string",
        "nulo": true,
        "enum": [
          "MANUAL",
          "AFTER_APPROVAL",
          "SCHEDULED"
        ]
      },
      "earliestReleaseDate": {
        "t": "string",
        "nulo": true,
        "formato": "date-time"
      },
      "usesIdfa": {
        "t": "boolean",
        "nulo": true
      },
      "downloadable": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "build": {
        "tipo": "builds",
        "lista": false
      },
      "appClipDefaultExperience": {
        "tipo": "appClipDefaultExperiences",
        "lista": false
      }
    },
    "relacoesObrigatorias": []
  },
  "AppUpdateRequest": {
    "tipo": "apps",
    "id": "obrigatorio",
    "atributos": {
      "accessibilityUrl": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      },
      "bundleId": {
        "t": "string",
        "nulo": true
      },
      "primaryLocale": {
        "t": "string",
        "nulo": true
      },
      "subscriptionStatusUrl": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      },
      "subscriptionStatusUrlVersion": {
        "t": "string",
        "nulo": true,
        "enum": [
          "V1",
          "V2"
        ]
      },
      "subscriptionStatusUrlForSandbox": {
        "t": "string",
        "nulo": true,
        "formato": "uri"
      },
      "subscriptionStatusUrlVersionForSandbox": {
        "t": "string",
        "nulo": true,
        "enum": [
          "V1",
          "V2"
        ]
      },
      "contentRightsDeclaration": {
        "t": "string",
        "nulo": true,
        "enum": [
          "DOES_NOT_USE_THIRD_PARTY_CONTENT",
          "USES_THIRD_PARTY_CONTENT"
        ]
      },
      "streamlinedPurchasingEnabled": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "DeviceCreateRequest": {
    "tipo": "devices",
    "id": "proibido",
    "atributos": {
      "name": {
        "t": "string"
      },
      "platform": {
        "t": "string",
        "enum": [
          "IOS",
          "MAC_OS",
          "UNIVERSAL"
        ]
      },
      "udid": {
        "t": "string"
      }
    },
    "atributosObrigatorios": [
      "name",
      "udid",
      "platform"
    ],
    "atributosObrigatorioNoCorpo": true,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "ReviewSubmissionCreateRequest": {
    "tipo": "reviewSubmissions",
    "id": "proibido",
    "atributos": {
      "platform": {
        "t": "string",
        "nulo": true,
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "app": {
        "tipo": "apps",
        "lista": false
      }
    },
    "relacoesObrigatorias": [
      "app"
    ]
  },
  "ReviewSubmissionItemCreateRequest": {
    "tipo": "reviewSubmissionItems",
    "id": "proibido",
    "atributos": {},
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "reviewSubmission": {
        "tipo": "reviewSubmissions",
        "lista": false
      },
      "appStoreVersion": {
        "tipo": "appStoreVersions",
        "lista": false
      },
      "appCustomProductPageVersion": {
        "tipo": "appCustomProductPageVersions",
        "lista": false
      },
      "appStoreVersionExperiment": {
        "tipo": "appStoreVersionExperiments",
        "lista": false
      },
      "appStoreVersionExperimentV2": {
        "tipo": "appStoreVersionExperiments",
        "lista": false
      },
      "appEvent": {
        "tipo": "appEvents",
        "lista": false
      },
      "appAssetLibraryImage": {
        "tipo": "appAssetLibraryImages",
        "lista": false
      },
      "appAssetLibraryVideo": {
        "tipo": "appAssetLibraryVideos",
        "lista": false
      },
      "backgroundAssetVersion": {
        "tipo": "backgroundAssetVersions",
        "lista": false
      },
      "gameCenterAchievementVersion": {
        "tipo": "gameCenterAchievementVersions",
        "lista": false
      },
      "gameCenterActivityVersion": {
        "tipo": "gameCenterActivityVersions",
        "lista": false
      },
      "gameCenterChallengeVersion": {
        "tipo": "gameCenterChallengeVersions",
        "lista": false
      },
      "gameCenterLeaderboardSetVersion": {
        "tipo": "gameCenterLeaderboardSetVersions",
        "lista": false
      },
      "gameCenterLeaderboardVersion": {
        "tipo": "gameCenterLeaderboardVersions",
        "lista": false
      },
      "inAppPurchaseVersion": {
        "tipo": "inAppPurchaseVersions",
        "lista": false
      },
      "subscriptionVersion": {
        "tipo": "subscriptionVersions",
        "lista": false
      },
      "subscriptionGroupVersion": {
        "tipo": "subscriptionGroupVersions",
        "lista": false
      },
      "retentionMessageVersion": {
        "tipo": "retentionMessageVersions",
        "lista": false
      }
    },
    "relacoesObrigatorias": [
      "reviewSubmission"
    ]
  },
  "ReviewSubmissionItemUpdateRequest": {
    "tipo": "reviewSubmissionItems",
    "id": "obrigatorio",
    "atributos": {
      "resolved": {
        "t": "boolean",
        "nulo": true
      },
      "removed": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  },
  "ReviewSubmissionUpdateRequest": {
    "tipo": "reviewSubmissions",
    "id": "obrigatorio",
    "atributos": {
      "platform": {
        "t": "string",
        "nulo": true,
        "enum": [
          "IOS",
          "MAC_OS",
          "TV_OS",
          "VISION_OS"
        ]
      },
      "submitted": {
        "t": "boolean",
        "nulo": true
      },
      "canceled": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  }
};

/** Esquemas dos itens de `included` (criação em linha, como o preço e o território). */
export const INCLUIDOS = {
  "AppPriceV2InlineCreate": {
    "tipo": "appPrices",
    "id": "opcional",
    "atributos": {
      "startDate": {
        "t": "string",
        "nulo": true,
        "formato": "date"
      },
      "endDate": {
        "t": "string",
        "nulo": true,
        "formato": "date"
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "appPricePoint": {
        "tipo": "appPricePoints",
        "lista": false
      }
    },
    "relacoesObrigatorias": []
  },
  "TerritoryAvailabilityInlineCreate": {
    "tipo": "territoryAvailabilities",
    "id": "opcional",
    "atributos": {
      "available": {
        "t": "boolean",
        "nulo": true
      },
      "releaseDate": {
        "t": "string",
        "nulo": true,
        "formato": "date"
      },
      "preOrderEnabled": {
        "t": "boolean",
        "nulo": true
      }
    },
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {
      "territory": {
        "tipo": "territories",
        "lista": false
      }
    },
    "relacoesObrigatorias": []
  },
  "TerritoryInlineCreate": {
    "tipo": "territories",
    "id": "opcional",
    "atributos": {},
    "atributosObrigatorios": [],
    "atributosObrigatorioNoCorpo": false,
    "relacoes": {},
    "relacoesObrigatorias": []
  }
};
