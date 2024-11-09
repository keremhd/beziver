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


async function onChange() {
    const file = InputFileUpload.files;
    if (file) {
        const fileReader = new FileReader();

        fileReader.onload = async (event) => {
            ImgSource.setAttribute('src', event.target.result);

            let image = await IJS.Image.load(ImgSource.src);
            let grey = image.grey().resize({ width:200, height: 200});
        
            ImgSource.src = grey.toDataURL();
        };
        
        fileReader.readAsDataURL(file[0]);
    }
}

async function onRun() {
    var W = 200;
    var H = 200;
    CanvasResult.width = W;
    CanvasResult.height = H;

    var ctx = CanvasResult.getContext("2d");
    
    var point = (x,y,z) => {
        return { x:x, y:y, z:z };
    }

    var quad = (p1,p2,p3,p4) => {
        var z = (p1.z + p2.z + p3.z + p4.z) / 4;
        if (z < 0) z = 0;
        if (z > 1) z = 1;

        const grayTone = Math.round(z*255);
        ctx.fillStyle = `rgb(${grayTone} ${grayTone} ${grayTone})`;

        ctx.beginPath();
        ctx.moveTo(p1.x * W, p1.y * H);
        ctx.lineTo(p2.x * W, p2.y * H);
        ctx.lineTo(p3.x * W, p3.y * H);
        ctx.lineTo(p4.x * W, p4.y * H);
        ctx.closePath();
        ctx.fill();
    }

    var N = 4;
    var points = [];
    for (var j = 0; j < N; j++) {
        points[j] = [];
        for (var i = 0; i < N; i++) {
            points[j][i] = point(i/(N-1) + .5-Math.random(), j/(N-1) + .5-Math.random(), Math.random());
        }
    }

    let $FS = 10;

    var luts = [];
    for (var j = 0; j < N; j++) {
        luts[j] = new Bezier(points[j]).getLUT($FS);
    }

    var pointMap = [];
    for (var y = 0; y < $FS; y++) {
        pointMap[y] = [];
        for (var x = 0; x < $FS; x++) {
            pointMap[y][x] = null;
        }
    }

    for (var x = 0; x < $FS; x++) {
        var midPoints = [];
        for (var j = 0; j < N; j++) {
            midPoints[j] = luts[j][x];
        }

        var midLuts = new Bezier(midPoints).getLUT($FS);

        for (var y = 0; y < $FS; y++) {
            pointMap[y][x] = midLuts[y];
        }
    }

    for (var x1 = 0; x1 < $FS-1; x1++) {
        for (var y1 = 0; y1 < $FS-1; y1++) {
            var x2 = x1+1;
            var y2 = y1+1;

            var p11 = pointMap[y1][x1];
            var p12 = pointMap[y1][x2];
            var p21 = pointMap[y2][x1];
            var p22 = pointMap[y2][x2];

            quad(p11, p12, p22, p21);
        }
    }

}

})();
