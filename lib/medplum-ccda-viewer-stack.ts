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

    // Static CCDA viewer in bucket
    new s3Deployment.BucketDeployment(this, "CcdaStaticContent", {
      sources: [s3Deployment.Source.asset("./www")],
      destinationBucket: ccdaViewerBucket,
    });

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
        },
        domainNames: [FULL_DOMAIN],
        certificate,
        defaultRootObject: "index.html",
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // Use only North America and Europe
        enabled: true,
      }
    );

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
