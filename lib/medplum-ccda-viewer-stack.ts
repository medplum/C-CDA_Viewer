import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3Deployment from "aws-cdk-lib/aws-s3-deployment";

const BASE_DOMAIN: string = process.env.BASE_DOMAIN ?? "";
const CCDA_VIEWER_SUBDOMAIN = process.env.CCDA_VIEWER_SUBDOMAIN || "ccda";
const FULL_DOMAIN = `${CCDA_VIEWER_SUBDOMAIN}.${BASE_DOMAIN}`;

if (!BASE_DOMAIN.length) {
  throw new Error("process.env.BASE_DOMAIN is required to be defined");
}

export class MedplumCcdaViewerStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the S3 bucket
    const ccdaViewerBucket = new s3.Bucket(this, "CcdaViewerBucket", {
      bucketName: FULL_DOMAIN,
      publicReadAccess: false, // We'll access through CloudFront only
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Look up existing hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, "MedplumZone", {
      domainName: BASE_DOMAIN,
    });

    // Create certificate for ccda.medplum.com
    const certificate = new acm.Certificate(this, "CcdaViewerCertificate", {
      domainName: FULL_DOMAIN,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Content-Security-Policy.
    //
    // NOTE: `frame-ancestors` is deliberately omitted. This is a single shared
    // distribution embedded by self-hosted Medplum installs at origins we cannot
    // enumerate. `frame-ancestors` does NOT fall back to `default-src`, so leaving
    // it out keeps the viewer embeddable. For the same reason, do NOT add
    // `frameOptions` to securityHeadersBehavior below -- X-Frame-Options has no
    // allowlist form and would block every embedder.
    //
    // `connect-src`/`img-src` are broad for the same reason: core.js fetches the
    // C-CDA over XHR from a URL the embedding app posts in (see iframe-messages.js),
    // and cda.xsl renders <img> from observationMedia references inside the
    // document itself. Neither origin is known at deploy time.
    const contentSecurityPolicy = [
      "default-src 'none'",
      "script-src 'self'",
      // 'unsafe-inline' is required: cda.xsl emits a <style> block and ~21 computed
      // style="..." attributes, and core.js calls .attr("style", ...) in adjustWidth().
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: https:",
      "connect-src 'self' https:",
      // base-uri and form-action do not fall back to default-src.
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "CcdaViewerResponseHeaders",
      {
        securityHeadersBehavior: {
          contentSecurityPolicy: { contentSecurityPolicy, override: true },
          // 730 days + preload matches app/api and the target in
          // medplum/medplum-ee#1087. Note X-Frame-Options is still deliberately
          // absent -- see the note above; the issue's checkbox for it would
          // break every embedder.
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(730),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
            override: true,
          },
        },
      }
    );

    // Create CloudFront distribution
    const distribution = new cloudfront.Distribution(
      this,
      "CcdaViewerDistribution",
      {
        defaultBehavior: {
          origin:
            origins.S3BucketOrigin.withOriginAccessControl(ccdaViewerBucket),
          compress: true,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy,
        },
        domainNames: [FULL_DOMAIN],
        certificate,
        defaultRootObject: "index.html",
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // Use only North America and Europe
        enabled: true,
      }
    );

    // Static CCDA viewer in bucket.
    //
    // NOTE: this must invalidate the distribution. CACHING_OPTIMIZED keys on the
    // normalized Accept-Encoding, so every object has separate gzip/br/identity
    // cache entries with independent TTLs. Without an invalidation a deploy can
    // leave a stale brotli copy of index.html served to real browsers (which ask
    // for br) while curl (which asks for identity) sees the new one -- which is
    // exactly how the CDN font-awesome link survived the switch to the vendored
    // copy and got blocked by style-src 'self'.
    new s3Deployment.BucketDeployment(this, "CcdaStaticContent", {
      sources: [s3Deployment.Source.asset("./www")],
      destinationBucket: ccdaViewerBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // Create DNS record
    new route53.ARecord(this, "CcdaViewerARecord", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution)
      ),
      recordName: FULL_DOMAIN,
    });

    // Output the distribution URL
    new cdk.CfnOutput(this, "DistributionUrl", {
      value: distribution.distributionDomainName,
      description: "CloudFront Distribution URL",
    });

    // Output the bucket name
    new cdk.CfnOutput(this, "BucketName", {
      value: ccdaViewerBucket.bucketName,
      description: "S3 Bucket Name",
    });
  }
}
