const Genetic = require('genetic-js');
const IJS = require('image-js');
import { Bezier } from "bezier-js";

(() => {



var genetic = Genetic.create();


const InputFileUpload = document.getElementById("file-upload");
const ImgSource = document.getElementById('source');
const ImgResult = document.getElementById('result');

const CanvasResult = document.getElementById('result-canvas');
const ButtonRun = document.getElementById('run');


InputFileUpload.addEventListener("change", onChange);
ButtonRun.addEventListener("click", onRun);

var GreyImage = null;

async function onChange() {
    const file = InputFileUpload.files;
    if (file) {
        const fileReader = new FileReader();

        fileReader.onload = async (event) => {
            ImgSource.setAttribute('src', event.target.result);

            let image = await IJS.Image.load(ImgSource.src);
            GreyImage = image.grey().resize({ width:200, height: 200});
        
            ImgSource.src = GreyImage.toDataURL();
        };
        
        fileReader.readAsDataURL(file[0]);
    }
}

function newPoint(x,y,z) {
    return { x:x, y:y, z:z };
}

function newControlGrid(N, randomize) {
    var points = [];

    for (var j = 0; j < N; j++) {
        points[j] = [];
        for (var i = 0; i < N; i++) {
            points[j][i] = newPoint(
                i/(N-1) + (randomize ? (.5-Math.random()) : 0.0),
                j/(N-1) + (randomize ? ( .5-Math.random()) : 0.0),
                (randomize ? Math.random() : 0.0));
        }
    }
    
    return points;
}

function drawQuad(ctx,W,H,p1,p2,p3,p4) {
    var z = (p1.z + p2.z + p3.z + p4.z) / 4;
    if (z < 0) z = 0;
    if (z > 1) z = 1;

    const grayTone = Math.round(z*255);
    ctx.fillStyle = `rgb(${grayTone} ${grayTone} ${grayTone})`;

    ctx.beginPath();
    ctx.moveTo(p1.x * W - .5, p1.y * H - .5);
    ctx.lineTo(p2.x * W + .5, p2.y * H - .5);
    ctx.lineTo(p3.x * W + .5, p3.y * H + .5);
    ctx.lineTo(p4.x * W - .5, p4.y * H + .5);
    ctx.closePath();
    ctx.fill();
}

function drawControlGrid(canvas, controlGrid, $fn) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width;
    var H = canvas.height;
    var N = controlGrid.length;

    var luts = [];
    for (var j = 0; j < N; j++) {
        luts[j] = new Bezier(controlGrid[j]).getLUT($fn);
    }

    var pointMap = [];
    for (var y = 0; y < $fn; y++) {
        pointMap[y] = [];
        for (var x = 0; x < $fn; x++) {
            pointMap[y][x] = null;
        }
    }

    for (var x = 0; x < $fn; x++) {
        var midPoints = [];
        for (var j = 0; j < N; j++) {
            midPoints[j] = luts[j][x];
        }

        var midLuts = new Bezier(midPoints).getLUT($fn);

        for (var y = 0; y < $fn; y++) {
            pointMap[y][x] = midLuts[y];
        }
    }

    for (var x1 = 0; x1 < $fn-1; x1++) {
        for (var y1 = 0; y1 < $fn-1; y1++) {
            var x2 = x1+1;
            var y2 = y1+1;

            var p11 = pointMap[y1][x1];
            var p12 = pointMap[y1][x2];
            var p21 = pointMap[y2][x1];
            var p22 = pointMap[y2][x2];

            drawQuad(ctx, W, H, p11, p12, p22, p21);
        }
    }
}

function calculateDistance(image1, canvas, numberOfSamples) {
    var image2 = IJS.Image.fromCanvas(canvas);

    var sumError = 0.0;
    for (var i = 0; i < numberOfSamples; i++) {
        let x = Math.random();
        let y = Math.random();

        let v1 = image1.getPixelXY(Math.floor(x * image1.width), Math.floor(y * image1.height))[0];
        let v2 = image2.getPixelXY(Math.floor(x * image2.width), Math.floor(y * image2.height))[0];
        sumError += (v1-v2)**2;
    }

    return sumError/numberOfSamples;
}

async function onRun() {

    var W = 200;
    var H = 200;
    var canvas = new OffscreenCanvas(W, H);
    let $fn = 10;

    var points = newControlGrid(4, true);
    drawControlGrid(canvas, points, $fn);


    console.log(calculateDistance(GreyImage, canvas, 1000));


    CanvasResult.width = W;
    CanvasResult.height = H;
    CanvasResult
        .getContext("bitmaprenderer")
        .transferFromImageBitmap(
            canvas.transferToImageBitmap());

}

})();
